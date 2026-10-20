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

const maxCreatorComments = 3;
const maxCommentChars = 10_000;

/* The JSON object a watch page assigns to `var <name> = {...};`, or null. */
const readAssignedJson = (pageHtml: string, name: string): unknown => {
  const marker = `var ${name} = `;
  const start = pageHtml.indexOf(marker);

  if (start === -1) {
    return null;
  }

  const end = pageHtml.indexOf(";</script>", start);

  try {
    return JSON.parse(pageHtml.slice(start + marker.length, end === -1 ? undefined : end));
  } catch {
    return null;
  }
};

/* Every object in a parsed JSON tree, depth first, except under the keys in `skipKeys`. */
function* walkJsonObjects(
  value: unknown,
  skipKeys: ReadonlySet<string> = new Set()
): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* walkJsonObjects(entry, skipKeys);
    }
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;

    yield record;

    for (const [key, entry] of Object.entries(record)) {
      if (!skipKeys.has(key)) {
        yield* walkJsonObjects(entry, skipKeys);
      }
    }
  }
}

/* The older layout nests a thread's replies (creator replies included) under these keys. */
const commentReplyKeys = new Set(["replies", "commentRepliesRenderer"]);

const readRecord = (value: unknown, key: string): Record<string, unknown> | null => {
  const entry =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;

  return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
};

/**
 * What the comments request needs from a watch page: the continuation token of its comment
 * section (ytInitialData) and the web client version it was served with.
 */
export const readYouTubeCommentsRequest = (
  pageHtml: string
): { token: string; clientVersion: string } | null => {
  const clientVersion = pageHtml.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/u)?.[1];
  const initialData = readAssignedJson(pageHtml, "ytInitialData");

  if (!clientVersion || !initialData) {
    return null;
  }

  for (const record of walkJsonObjects(initialData)) {
    const section = readRecord(record, "itemSectionRenderer");

    if (section?.sectionIdentifier !== "comment-item-section") {
      continue;
    }

    for (const inner of walkJsonObjects(section.contents)) {
      const token = readRecord(inner, "continuationCommand")?.token;

      if (typeof token === "string" && token.length > 0) {
        return { token, clientVersion };
      }
    }
  }

  return null;
};

/**
 * The text of the creator's own top-level comments in a comments response: the current entity
 * payloads (author.isCreator) and the older commentRenderer (authorIsChannelOwner).
 */
export const readYouTubeCreatorComments = (response: unknown): string[] => {
  const comments: string[] = [];

  for (const record of walkJsonObjects(response, commentReplyKeys)) {
    const entity = readRecord(record, "commentEntityPayload");
    const renderer = readRecord(record, "commentRenderer");
    let text: unknown = null;

    if (entity) {
      const properties = readRecord(entity, "properties");

      if (readRecord(entity, "author")?.isCreator === true && !properties?.replyLevel) {
        text = readRecord(properties, "content")?.content;
      }
    } else if (renderer?.authorIsChannelOwner === true) {
      const runs = readRecord(renderer, "contentText")?.runs;

      text = Array.isArray(runs)
        ? runs
            .map((run: { text?: unknown } | null) =>
              typeof run?.text === "string" ? run.text : ""
            )
            .join("")
        : null;
    }

    if (typeof text === "string" && text.trim().length > 0) {
      comments.push(text.trim().slice(0, maxCommentChars));
    }
  }

  return [...new Set(comments)].slice(0, maxCreatorComments);
};

/*
 * The first page of the video's comments, through the same endpoint the watch page uses, and the
 * creator's own comments in it. Any failure means no comments: they are a fallback source.
 */
const fetchCreatorComments = async (
  pageHtml: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string[]> => {
  const commentsRequest = readYouTubeCommentsRequest(pageHtml);

  if (!commentsRequest) {
    return [];
  }

  const timeout = createTimeoutSignal(timeoutMs, signal);

  try {
    const response = await fetchImplementation(
      "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "accept-language": browserLikeHeaders["accept-language"],
          "content-type": "application/json",
          "user-agent": browserLikeHeaders["user-agent"]
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: commentsRequest.clientVersion,
              hl: "en"
            }
          },
          continuation: commentsRequest.token
        }),
        signal: timeout.signal
      }
    );

    if (!response.ok) {
      return [];
    }

    return readYouTubeCreatorComments(
      JSON.parse(await readLimitedResponseText(response, maxBytes)) as unknown
    );
  } catch {
    return [];
  } finally {
    timeout.cleanup();
  }
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
    /* The creator's comments load while the transcript does. */
    const creatorCommentsRequest = fetchCreatorComments(
      pageHtml,
      fetchImplementation,
      timeoutMs,
      maxBytes,
      options?.signal
    );
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
    const creatorComments = await creatorCommentsRequest;
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
      creatorComments,
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
