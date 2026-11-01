import { isAbortError } from "../deadline.js";
import { validatePublicSourceUrl } from "../source-url-safety.js";

import { downloadSocialVideo } from "./download-social-video.js";
import { SocialFetchError } from "./errors.js";
import { isFacebookMediaUrl } from "./fetch-facebook-document.js";
import { createTimeoutSignal, ResponseBodyTooLargeError } from "./shared.js";

import type { TikTokVideoFile } from "./fetch-tiktok-video.js";
import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { FacebookVideoLocator } from "../types.js";

/*
 * The video file behind a Facebook video or reel, for the video recipe reader. The post's public
 * page (already fetched for the caption) links a progressive MP4 on Facebook's CDN that needs no
 * login; fetchFacebookDocument reads it into the locator. The link is held to fbcdn.net and the
 * usual public-address check on every hop.
 */
export interface FetchFacebookVideoOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Videos the link says are longer are refused before downloading. */
  maxSeconds: number;
  signal?: AbortSignal | undefined;
  validateUrl?: ValidateSourceUrl | undefined;
}

export const fetchFacebookVideo = async (
  locator: FacebookVideoLocator,
  fetchImplementation: typeof fetch,
  options: FetchFacebookVideoOptions
): Promise<TikTokVideoFile> => {
  if (locator.durationSeconds !== null && locator.durationSeconds > options.maxSeconds) {
    throw new SocialFetchError("That Facebook video is too long to read.", "too_large");
  }

  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const media = await downloadSocialVideo(locator.mediaUrl, {
      platform: "Facebook",
      isMediaUrl: isFacebookMediaUrl,
      referer: "https://www.facebook.com/",
      fetchImplementation,
      validateUrl: options.validateUrl ?? validatePublicSourceUrl,
      maxBytes: options.maxBytes,
      signal: timeout.signal
    });

    return { ...media, durationSeconds: locator.durationSeconds };
  } catch (error) {
    if (error instanceof SocialFetchError) {
      throw error;
    }

    if (error instanceof ResponseBodyTooLargeError) {
      throw new SocialFetchError("That Facebook video is too large to read.", "too_large");
    }

    if (timeout.signal.aborted || isAbortError(error)) {
      throw new SocialFetchError("Facebook video download timed out.", "timeout");
    }

    throw new SocialFetchError(
      error instanceof Error ? error.message : "Facebook video download failed.",
      "unreachable"
    );
  } finally {
    timeout.cleanup();
  }
};
