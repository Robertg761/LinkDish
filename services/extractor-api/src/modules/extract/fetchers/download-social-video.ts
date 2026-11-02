import { isSourceUrlRejection } from "../source-url-safety.js";

import { SocialFetchError } from "./errors.js";
import { browserLikeHeaders, getContentTypeEssence, readLimitedResponseBytes } from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";

/*
 * Downloads a social video's MP4 for the video recipe reader. The link comes from page content,
 * so every redirect hop is held to the platform's own media hosts and the usual public-address
 * check, and the body is capped.
 */
export interface DownloadSocialVideoOptions {
  /** "TikTok" or "Facebook", for error messages. */
  platform: string;
  isMediaUrl: (url: string) => boolean;
  referer: string;
  fetchImplementation: typeof fetch;
  validateUrl: ValidateSourceUrl;
  maxBytes: number;
  signal: AbortSignal;
}

const maxMediaRedirects = 3;

export const discardResponseBody = (response: Response): void => {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;

  if (body && typeof body.cancel === "function") {
    void body.cancel().catch(() => undefined);
  }
};

const assertSafeMediaUrl = async (
  url: string,
  { platform, isMediaUrl, validateUrl }: DownloadSocialVideoOptions
): Promise<void> => {
  if (!isMediaUrl(url)) {
    throw new SocialFetchError(`${platform} video link pointed outside ${platform}.`, "blocked");
  }

  const safety = await validateUrl(url);

  if (isSourceUrlRejection(safety)) {
    throw new SocialFetchError(`Refused unsafe ${platform} video URL: ${safety.reason}`, "blocked");
  }
};

export const downloadSocialVideo = async (
  mediaUrl: string,
  options: DownloadSocialVideoOptions
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string }> => {
  const { platform } = options;
  let current = mediaUrl;

  for (let hop = 0; hop <= maxMediaRedirects; hop += 1) {
    await assertSafeMediaUrl(current, options);

    const response = await options.fetchImplementation(current, {
      headers: {
        accept: "video/mp4,video/*;q=0.9,*/*;q=0.5",
        "user-agent": browserLikeHeaders["user-agent"],
        referer: options.referer
      },
      redirect: "manual",
      signal: options.signal
    });
    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      discardResponseBody(response);
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      discardResponseBody(response);
      throw new SocialFetchError(
        `${platform} video download failed with ${response.status}.`,
        response.status === 403 || response.status === 429 ? "blocked" : "unreachable",
        response.status
      );
    }

    const mimeType = getContentTypeEssence(response.headers.get("content-type")) || "video/mp4";

    if (!mimeType.startsWith("video/")) {
      discardResponseBody(response);
      throw new SocialFetchError(
        `${platform} video link did not return a video.`,
        "unsupported_content_type"
      );
    }

    return { bytes: await readLimitedResponseBytes(response, options.maxBytes), mimeType };
  }

  throw new SocialFetchError(`${platform} video redirected too many times.`, "blocked");
};
