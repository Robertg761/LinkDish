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

const oEmbedMaxBytes = 256 * 1024;
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

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

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

    const caption = readString(payload.title);
    const thumbnailUrl = readString(payload.thumbnail_url);

    return {
      kind: "text",
      url: videoUrl,
      origin: "tiktok",
      text: (caption ?? "").slice(0, maxCaptionChars),
      title: null,
      authorName: readString(payload.author_name),
      thumbnailUrl: thumbnailUrl && isHttpUrl(thumbnailUrl) ? thumbnailUrl : null
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
