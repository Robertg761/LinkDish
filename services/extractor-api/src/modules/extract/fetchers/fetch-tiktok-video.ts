import { isAbortError } from "../deadline.js";
import { validatePublicSourceUrl } from "../source-url-safety.js";

import { downloadSocialVideo } from "./download-social-video.js";
import { SocialFetchError } from "./errors.js";
import {
  fetchTikTokEmbedVideoData,
  readTikTokEmbedMedia,
  readTikTokVideoId
} from "./fetch-tiktok-document.js";
import { createTimeoutSignal, ResponseBodyTooLargeError } from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { TikTokVideoLocator } from "../types.js";

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
  /**
   * What the caption fetch found: the video id (from the URL or oEmbed) and, when it read the
   * embed page, the MP4 link, so that page is not fetched twice.
   */
  locator?: TikTokVideoLocator | undefined;
}

const tiktokMediaHostPattern =
  /(?:^|\.)(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com|tiktokv\.us|tiktokv\.eu|byteoversea\.com|ibytedtos\.com|muscdn\.com)$/u;

const isTikTokMediaUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && tiktokMediaHostPattern.test(parsed.hostname);
  } catch {
    return false;
  }
};

export const fetchTikTokVideo = async (
  videoUrl: string,
  fetchImplementation: typeof fetch,
  options: FetchTikTokVideoOptions
): Promise<TikTokVideoFile> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const videoId = options.locator?.videoId ?? readTikTokVideoId(videoUrl);

  if (!videoId) {
    throw new SocialFetchError("That TikTok link does not name a video.", "not_found");
  }

  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const { mediaUrl, durationSeconds } = options.locator?.mediaUrl
      ? options.locator
      : readTikTokEmbedMedia(
          (await fetchTikTokEmbedVideoData(
            videoId,
            fetchImplementation,
            validateUrl,
            timeout.signal
          )) ?? {}
        );

    if (!mediaUrl) {
      throw new SocialFetchError("TikTok did not link a playable video.", "not_found");
    }

    if (durationSeconds !== null && durationSeconds > options.maxSeconds) {
      throw new SocialFetchError("That TikTok video is too long to read.", "too_large");
    }

    const media = await downloadSocialVideo(mediaUrl, {
      platform: "TikTok",
      isMediaUrl: isTikTokMediaUrl,
      referer: "https://www.tiktok.com/",
      fetchImplementation,
      validateUrl,
      maxBytes: options.maxBytes,
      signal: timeout.signal
    });

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
