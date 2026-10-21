import { isHttpUrl } from "../../../../../../packages/recipe-domain/src/index.js";
import { isAbortError } from "../deadline.js";
import { isTikTokUrl } from "../source-detection/detect-source-from-url.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { SocialFetchError } from "./errors.js";
import {
  browserLikeHeaders,
  createTimeoutSignal,
  readLimitedResponseText,
  ResponseBodyTooLargeError
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { TextSourceDocument } from "../types.js";

/*
 * TikTok pages are script-rendered and bot-walled, but TikTok publishes a public oEmbed
 * endpoint that returns a video's caption (as `title`), its author and a thumbnail. The caption
 * is where creators put their recipes, so it is all LinkDish needs; the video itself is never
 * downloaded. Short links (vm.tiktok.com, tiktok.com/t/...) are resolved first with the same
 * SSRF rules as every other fetch: manual redirects, each hop validated, TikTok hosts only.
 */
export const TIKTOK_OEMBED_ENDPOINT = "https://www.tiktok.com/oembed";
/*
 * Since October 2026 oEmbed can answer with a bare player iframe and no caption. The embed page
 * TikTok serves for that player still carries the caption, author and cover in its page state.
 */
export const TIKTOK_EMBED_PAGE_ENDPOINT = "https://www.tiktok.com/embed/v2";

const oEmbedMaxBytes = 256 * 1024;
const embedPageMaxBytes = 2 * 1024 * 1024;
const maxShortLinkRedirects = 5;
const maxCaptionChars = 5_000;

export interface FetchTikTokDocumentOptions {
  timeoutMs: number;
  /** The request deadline or a cancellation. */
  signal?: AbortSignal | undefined;
  validateUrl?: ValidateSourceUrl | undefined;
}

const isShortLink = (url: string): boolean => {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();

  return (
    hostname === "vm.tiktok.com" ||
    hostname === "vt.tiktok.com" ||
    /^\/t\//u.test(parsedUrl.pathname)
  );
};

/* https://www.tiktok.com/@cook/video/123?is_from_webapp=1 → https://www.tiktok.com/@cook/video/123 */
const toCanonicalVideoUrl = (url: string): string => {
  const parsedUrl = new URL(url);
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString();
};

const assertSafe = async (url: string, validateUrl: ValidateSourceUrl): Promise<void> => {
  const safety = await validateUrl(url);

  if (isSourceUrlRejection(safety)) {
    throw new SocialFetchError(
      `Refused unsafe TikTok URL: ${safety.reason}`,
      safety.reason === "dns_lookup_failed" ? "unreachable" : "blocked"
    );
  }
};

const discardBody = (response: Response): void => {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (body && typeof body.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
};

const resolveShortLink = async (
  url: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<string> => {
  let current = url;

  for (let hop = 0; hop <= maxShortLinkRedirects; hop += 1) {
    await assertSafe(current, validateUrl);

    const response = await fetchImplementation(current, {
      headers: browserLikeHeaders,
      redirect: "manual",
      signal
    });
    const location = response.headers.get("location");
    discardBody(response);

    if (response.status < 300 || response.status >= 400 || !location) {
      return current;
    }

    const next = new URL(location, current).toString();

    if (!isTikTokUrl(next)) {
      throw new SocialFetchError("TikTok short link pointed outside TikTok.", "blocked");
    }

    if (!isShortLink(next)) {
      return next;
    }

    current = next;
  }

  throw new SocialFetchError("TikTok short link redirected too many times.", "blocked");
};

const classifyOEmbedStatus = (status: number): SocialFetchError["reason"] =>
  status === 400 || status === 404 || status === 410
    ? "not_found"
    : status === 401 || status === 403 || status === 429
      ? "blocked"
      : "unreachable";

/*
 * TikTok returns a caption with its line breaks flattened into spaces; where a line ended there
 * are usually two or more. Those become line breaks again, so "Ingredients" and each item get
 * their own line for the recipe parser.
 */
const restoreCaptionLines = (caption: string): string => caption.replace(/[^\S\n]{2,}/gu, "\n");

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface TikTokPost {
  caption: string | null;
  authorName: string | null;
  thumbnailUrl: string | null;
}

/* https://www.tiktok.com/@cook/video/123 → 123; oEmbed's embed_product_id names it too. */
const readVideoId = (videoUrl: string, payload: Record<string, unknown>): string | null =>
  new URL(videoUrl).pathname.match(/\/(?:video|photo)\/(\d+)/u)?.[1] ??
  readString(payload.embed_product_id)?.match(/^\d+$/u)?.[0] ??
  null;

/**
 * The video's record in the embed page's state (caption, author, covers and a playable MP4
 * link), or null when the page is missing, too large or carries no state.
 */
export const fetchTikTokEmbedVideoData = async (
  videoId: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<Record<string, unknown> | null> => {
  const embedUrl = `${TIKTOK_EMBED_PAGE_ENDPOINT}/${videoId}`;

  await assertSafe(embedUrl, validateUrl);

  const response = await fetchImplementation(embedUrl, {
    headers: browserLikeHeaders,
    redirect: "manual",
    signal
  });

  if (!response.ok) {
    discardBody(response);
    return null;
  }

  let html: string;

  try {
    html = await readLimitedResponseText(response, embedPageMaxBytes);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      return null;
    }

    throw error;
  }

  const stateJson = html.match(
    /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/u
  )?.[1];

  if (!stateJson) {
    return null;
  }

  let state: unknown;

  try {
    state = JSON.parse(stateJson);
  } catch {
    return null;
  }

  const pageData = readRecord(readRecord(readRecord(state).source).data);
  const videoData = readRecord(readRecord(pageData[`/embed/v2/${videoId}`]).videoData);

  return Object.keys(videoData).length > 0 ? videoData : null;
};

const fetchEmbedPagePost = async (
  videoId: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<TikTokPost | null> => {
  const videoData = await fetchTikTokEmbedVideoData(
    videoId,
    fetchImplementation,
    validateUrl,
    signal
  );

  if (!videoData) {
    return null;
  }

  const itemInfos = readRecord(videoData.itemInfos);
  const authorInfos = readRecord(videoData.authorInfos);
  const covers = Array.isArray(itemInfos.covers) ? (itemInfos.covers as unknown[]) : [];

  return {
    caption: readString(itemInfos.text),
    authorName: readString(authorInfos.nickName) ?? readString(authorInfos.uniqueId),
    thumbnailUrl: readString(covers[0])
  };
};

export const fetchTikTokDocument = async (
  url: string,
  fetchImplementation: typeof fetch,
  options: FetchTikTokDocumentOptions
): Promise<TextSourceDocument> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const videoUrl = toCanonicalVideoUrl(
      isShortLink(url)
        ? await resolveShortLink(url, fetchImplementation, validateUrl, timeout.signal)
        : url
    );
    const oEmbedUrl = `${TIKTOK_OEMBED_ENDPOINT}?url=${encodeURIComponent(videoUrl)}`;

    await assertSafe(oEmbedUrl, validateUrl);

    const response = await fetchImplementation(oEmbedUrl, {
      headers: {
        accept: "application/json",
        "accept-language": browserLikeHeaders["accept-language"],
        "user-agent": browserLikeHeaders["user-agent"]
      },
      redirect: "manual",
      signal: timeout.signal
    });

    if (!response.ok) {
      discardBody(response);
      throw new SocialFetchError(
        `TikTok oEmbed failed with ${response.status}.`,
        classifyOEmbedStatus(response.status),
        response.status
      );
    }

    let payload: Record<string, unknown>;

    try {
      const parsed = JSON.parse(await readLimitedResponseText(response, oEmbedMaxBytes)) as unknown;
      payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new SocialFetchError("TikTok oEmbed response was too large.", "too_large");
      }

      if (timeout.signal.aborted || isAbortError(error)) {
        throw error;
      }

      throw new SocialFetchError("TikTok oEmbed returned invalid JSON.", "unreachable");
    }

    let post: TikTokPost = {
      caption: readString(payload.title),
      authorName: readString(payload.author_name),
      thumbnailUrl: readString(payload.thumbnail_url)
    };
    const videoId = post.caption ? null : readVideoId(videoUrl, payload);

    if (videoId) {
      /* The embed page is a best-effort extra: if it fails, the oEmbed answer still stands. */
      const embedPost = await fetchEmbedPagePost(
        videoId,
        fetchImplementation,
        validateUrl,
        timeout.signal
      ).catch((error: unknown) => {
        if (timeout.signal.aborted || isAbortError(error)) {
          throw error;
        }

        return null;
      });

      post = {
        caption: embedPost?.caption ?? post.caption,
        authorName: post.authorName ?? embedPost?.authorName ?? null,
        thumbnailUrl: post.thumbnailUrl ?? embedPost?.thumbnailUrl ?? null
      };
    }

    return {
      kind: "text",
      url: videoUrl,
      origin: "tiktok",
      text: restoreCaptionLines(post.caption ?? "").slice(0, maxCaptionChars),
      title: null,
      authorName: post.authorName,
      thumbnailUrl: post.thumbnailUrl && isHttpUrl(post.thumbnailUrl) ? post.thumbnailUrl : null
    };
  } catch (error) {
    if (error instanceof SocialFetchError) {
      throw error;
    }

    if (timeout.signal.aborted || isAbortError(error)) {
      throw new SocialFetchError(
        options.signal?.aborted && !timeout.timedOut()
          ? "TikTok request was cancelled or ran out of request time."
          : "TikTok request timed out.",
        "timeout"
      );
    }

    throw new SocialFetchError(
      error instanceof Error ? error.message : "TikTok request failed.",
      "unreachable"
    );
  } finally {
    timeout.cleanup();
  }
};
