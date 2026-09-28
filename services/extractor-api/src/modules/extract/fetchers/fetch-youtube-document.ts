import { load } from "cheerio";

import { extractorApiEnv } from "../../../config/env.js";
import { readJsonStringLiteral } from "../html/json-string-literal.js";
import { toYouTubeWatchUrl } from "../source-detection/parse-youtube-video-id.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { YouTubeFetchError } from "./errors.js";
import {
  browserLikeHeaders,
  createTimeoutSignal,
  isHtmlLikeContentType,
  readLimitedResponseText,
  ResponseBodyTooLargeError
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { YouTubeSourceDocument } from "../types.js";

export { YouTubeFetchError } from "./errors.js";

export interface FetchYouTubeDocumentOptions {
  maxBytes?: number;
  validateUrl?: ValidateSourceUrl;
  /** The request deadline or a cancellation. */
  signal?: AbortSignal;
}

const readLimitedYouTubeText = async (response: Response, maxBytes: number): Promise<string> => {
  try {
    return await readLimitedResponseText(response, maxBytes);
  } catch (error) {
    if (error instanceof ResponseBodyTooLargeError) {
      throw new YouTubeFetchError(
        `Failed to fetch YouTube document: ${error.message}`,
        "too_large"
      );
    }

    throw error;
  }
};

/*
 * youtube-transcript does its own networking without a timeout or abort
 * signal, so it is raced against the request budget instead of being awaited
 * unbounded.
 */
const fetchTranscriptFromLibrary = async (
  videoId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> => {
  const timeout = createTimeoutSignal(timeoutMs, signal);

  try {
    const transcriptPromise = import("youtube-transcript").then(({ YoutubeTranscript }) =>
      YoutubeTranscript.fetchTranscript(videoId)
    );
    const abortPromise = new Promise<null>((resolve) => {
      if (timeout.signal.aborted) {
        resolve(null);
        return;
      }

      timeout.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const transcript = await Promise.race([transcriptPromise.catch(() => null), abortPromise]);

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return null;
    }

    return transcript.map((entry) => entry.text).join(" ");
  } catch {
    return null;
  } finally {
    timeout.cleanup();
  }
};

const decodeCaptionText = (value: string): string =>
  load(`<root>${value}</root>`, {
    xmlMode: true
  })("root")
    .text()
    .replace(/\s+/g, " ")
    .trim();

const fetchTranscriptFromCaptionTrack = async (
  pageHtml: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
  validateUrl: ValidateSourceUrl,
  signal?: AbortSignal
): Promise<string | null> => {
  const captionTrackMatch = pageHtml.match(/"captionTracks":(\[[^\]]+\])/);

  if (!captionTrackMatch) {
    return null;
  }

  try {
    const rawCaptionTracks = captionTrackMatch[1];

    if (!rawCaptionTracks) {
      return null;
    }

    const captionTracks = JSON.parse(rawCaptionTracks.replace(/\\u0026/g, "&")) as Array<{
      baseUrl?: string;
    }>;
    const captionUrl = captionTracks.find((track) => typeof track.baseUrl === "string")?.baseUrl;

    if (!captionUrl) {
      return null;
    }

    /*
     * The caption baseUrl is parsed out of the watch page, so it is
     * attacker-influenced content and has to pass the same SSRF validation as
     * every other fetch on the extract path.
     */
    const captionUrlSafety = await validateUrl(captionUrl);

    if (isSourceUrlRejection(captionUrlSafety)) {
      return null;
    }

    const timeout = createTimeoutSignal(timeoutMs, signal);

    try {
      const response = await fetchImplementation(captionUrl, {
        headers: {
          "accept-language": browserLikeHeaders["accept-language"]
        },
        signal: timeout.signal
      });

      if (!response.ok) {
        return null;
      }

      const xml = await readLimitedYouTubeText(response, maxBytes);
      const segments = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
        .map((match) => decodeCaptionText(match[1] ?? ""))
        .filter(Boolean);

      return segments.length > 0 ? segments.join(" ") : null;
    } finally {
      timeout.cleanup();
    }
  } catch {
    return null;
  }
};

const maxDescriptionChars = 10_000;

/**
 * The full video description from the watch page's ytInitialPlayerResponse
 * (videoDetails.shortDescription). og:description is cut to ~160 characters, which drops the
 * ingredient list creators paste into their descriptions.
 */
export const extractYouTubeShortDescription = (pageHtml: string): string | null => {
  const marker = '"shortDescription":"';
  const videoDetailsIndex = pageHtml.indexOf('"videoDetails":{');
  const markerIndex = pageHtml.indexOf(marker, Math.max(0, videoDetailsIndex));

  if (markerIndex === -1) {
    return null;
  }

  const description = readJsonStringLiteral(pageHtml, markerIndex + marker.length - 1)?.trim();

  return description ? description.slice(0, maxDescriptionChars) : null;
};

const parseChapterLines = (text: string): string[] =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^\d{1,2}:\d{2}(?::\d{2})?\s+/.test(line));

const toYouTubeRequestError = (error: unknown, signal: AbortSignal): YouTubeFetchError => {
  if (error instanceof YouTubeFetchError) {
    return error;
  }

  return new YouTubeFetchError(
    error instanceof Error ? error.message : "YouTube request failed.",
    signal.aborted ? "timeout" : "unreachable"
  );
};

export const fetchYouTubeDocument = async (
  url: string,
  videoId: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  options?: FetchYouTubeDocumentOptions
): Promise<YouTubeSourceDocument> => {
  const maxBytes = options?.maxBytes ?? extractorApiEnv.FETCH_MAX_RESPONSE_BYTES;
  const validateUrl = options?.validateUrl ?? validatePublicSourceUrl;
  /*
   * Shorts, embeds and youtu.be links are all read through the canonical watch page, which is
   * the page that carries the player response (full description, caption tracks).
   */
  const watchUrl = toYouTubeWatchUrl(videoId);
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const oEmbedTimeout = createTimeoutSignal(timeoutMs, options?.signal);
  const watchTimeout = createTimeoutSignal(timeoutMs, options?.signal);

  /* The oEmbed metadata and the watch page are independent, so they load in parallel. */
  const oEmbedRequest = fetchImplementation(oEmbedUrl, {
    headers: {
      "accept-language": browserLikeHeaders["accept-language"]
    },
    signal: oEmbedTimeout.signal
  });
  const watchRequest = fetchImplementation(watchUrl, {
    headers: browserLikeHeaders,
    signal: watchTimeout.signal
  });

  void watchRequest.catch(() => undefined);

  try {
    const oEmbedResponse = await oEmbedRequest.catch((error: unknown) => {
      throw toYouTubeRequestError(error, oEmbedTimeout.signal);
    });

    if (!oEmbedResponse.ok) {
      throw new YouTubeFetchError(
        `Failed to fetch YouTube metadata: ${oEmbedResponse.status}`,
        oEmbedResponse.status === 403 || oEmbedResponse.status === 429 ? "blocked" : "unreachable"
      );
    }

    const metadata = JSON.parse(await readLimitedYouTubeText(oEmbedResponse, maxBytes)) as {
      title?: string;
      author_name?: string;
    };
    const watchResponse = await watchRequest.catch((error: unknown) => {
      throw toYouTubeRequestError(error, watchTimeout.signal);
    });

    if (!watchResponse.ok) {
      throw new YouTubeFetchError(
        `Failed to fetch YouTube watch page: ${watchResponse.status}`,
        watchResponse.status === 403 || watchResponse.status === 429 ? "blocked" : "unreachable"
      );
    }

    if (!isHtmlLikeContentType(watchResponse.headers.get("content-type"))) {
      throw new YouTubeFetchError(
        "Refused non-HTML YouTube watch page content type.",
        "unreachable"
      );
    }

    const pageHtml = await readLimitedYouTubeText(watchResponse, maxBytes);
    const $ = load(pageHtml);
    const title =
      metadata.title ??
      $('meta[property="og:title"]').attr("content")?.trim() ??
      $("title").text().trim() ??
      null;
    const description =
      extractYouTubeShortDescription(pageHtml) ??
      $('meta[property="og:description"]').attr("content")?.trim() ??
      $('meta[name="description"]').attr("content")?.trim() ??
      (metadata.author_name ? `Creator: ${metadata.author_name}` : null);
    const transcript =
      (await fetchTranscriptFromLibrary(videoId, timeoutMs, options?.signal)) ??
      (await fetchTranscriptFromCaptionTrack(
        pageHtml,
        fetchImplementation,
        timeoutMs,
        maxBytes,
        validateUrl,
        options?.signal
      ));
    const chapters = parseChapterLines(description ?? "");

    return {
      kind: "youtube",
      url,
      videoId,
      title,
      description,
      transcript,
      chapters,
      pageHtml,
      authorName:
        typeof metadata.author_name === "string" && metadata.author_name.trim().length > 0
          ? metadata.author_name.trim()
          : null
    };
  } catch (error) {
    /* Do not keep downloading a watch page nobody will read. */
    watchTimeout.abort();
    throw error;
  } finally {
    oEmbedTimeout.cleanup();
    watchTimeout.cleanup();
  }
};
