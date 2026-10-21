import { isAbortError } from "../deadline.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { SocialFetchError } from "./errors.js";
import { fetchTikTokEmbedVideoData } from "./fetch-tiktok-document.js";
import {
  browserLikeHeaders,
  createTimeoutSignal,
  getContentTypeEssence,
  readLimitedResponseBytes,
  ResponseBodyTooLargeError
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";

/*
 * The video file behind a TikTok post, for the video recipe reader. The embed page TikTok serves
 * for its player (already read for captions) links the MP4 on TikTok's CDN, and that link needs
 * no cookies. The link comes from page content, so it is held to TikTok's own media hosts and the
 * usual public-address check, on every redirect hop.
 */
export interface TikTokVideoFile {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** From the embed page; null when it does not say. */
  durationSeconds: number | null;
}

export interface FetchTikTokVideoOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Videos the embed page says are longer are refused before downloading. */
  maxSeconds: number;
  signal?: AbortSignal | undefined;
  validateUrl?: ValidateSourceUrl | undefined;
}

const tiktokMediaHostPattern =
  /(?:^|\.)(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com|tiktokv\.us|tiktokv\.eu|byteoversea\.com|ibytedtos\.com|muscdn\.com)$/u;
const maxMediaRedirects = 3;

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/* https://www.tiktok.com/@cook/video/123 → 123 */
export const readTikTokVideoId = (videoUrl: string): string | null =>
  new URL(videoUrl).pathname.match(/\/video\/(\d+)/u)?.[1] ?? null;

const isTikTokMediaUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && tiktokMediaHostPattern.test(parsed.hostname);
  } catch {
    return false;
  }
};

const assertSafeMediaUrl = async (url: string, validateUrl: ValidateSourceUrl): Promise<void> => {
  if (!isTikTokMediaUrl(url)) {
    throw new SocialFetchError("TikTok video link pointed outside TikTok.", "blocked");
  }

  const safety = await validateUrl(url);

  if (isSourceUrlRejection(safety)) {
    throw new SocialFetchError(`Refused unsafe TikTok video URL: ${safety.reason}`, "blocked");
  }
};

const discardBody = (response: Response): void => {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (body && typeof body.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
};

const downloadMedia = async (
  mediaUrl: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> => {
  let current = mediaUrl;

  for (let hop = 0; hop <= maxMediaRedirects; hop += 1) {
    await assertSafeMediaUrl(current, validateUrl);

    const response = await fetchImplementation(current, {
      headers: {
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
        "user-agent": browserLikeHeaders["user-agent"],
        referer: "https://www.tiktok.com/"
      },
      redirect: "manual",
      signal
    });
    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      discardBody(response);
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      discardBody(response);
      throw new SocialFetchError(
        `TikTok video download failed with ${response.status}.`,
        response.status === 403 || response.status === 429 ? "blocked" : "unreachable",
        response.status
      );
    }

    const mimeType = getContentTypeEssence(response.headers.get("content-type")) || "video/mp4";

    if (!mimeType.startsWith("video/")) {
      discardBody(response);
      throw new SocialFetchError(
        "TikTok video link did not return a video.",
        "unsupported_content_type"
      );
    }

    return { bytes: await readLimitedResponseBytes(response, maxBytes), mimeType };
  }

  throw new SocialFetchError("TikTok video redirected too many times.", "blocked");
};

export const fetchTikTokVideo = async (
  videoUrl: string,
  fetchImplementation: typeof fetch,
  options: FetchTikTokVideoOptions
): Promise<TikTokVideoFile> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const videoId = readTikTokVideoId(videoUrl);

  if (!videoId) {
    throw new SocialFetchError("That TikTok link does not name a video.", "not_found");
  }

  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const videoData = await fetchTikTokEmbedVideoData(
      videoId,
      fetchImplementation,
      validateUrl,
      timeout.signal
    );
    const video = readRecord(readRecord(videoData?.itemInfos).video);
    const urls = Array.isArray(video.urls) ? (video.urls as unknown[]) : [];
    const mediaUrl = urls.find((url): url is string => typeof url === "string");
    const duration = readRecord(video.videoMeta).duration;
    const durationSeconds = typeof duration === "number" && duration > 0 ? duration : null;

    if (!mediaUrl) {
      throw new SocialFetchError("TikTok did not link a playable video.", "not_found");
    }

    if (durationSeconds !== null && durationSeconds > options.maxSeconds) {
      throw new SocialFetchError("That TikTok video is too long to read.", "too_large");
    }

    const media = await downloadMedia(
      mediaUrl,
      fetchImplementation,
      validateUrl,
      options.maxBytes,
      timeout.signal
    );

    return { ...media, durationSeconds };
  } catch (error) {
    if (error instanceof SocialFetchError) {
      throw error;
    }

    if (error instanceof ResponseBodyTooLargeError) {
      throw new SocialFetchError("That TikTok video is too large to read.", "too_large");
    }

    if (timeout.signal.aborted || isAbortError(error)) {
      throw new SocialFetchError("TikTok video download timed out.", "timeout");
    }

    throw new SocialFetchError(
      error instanceof Error ? error.message : "TikTok video download failed.",
      "unreachable"
    );
  } finally {
    timeout.cleanup();
  }
};
