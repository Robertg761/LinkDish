import { load } from "cheerio";

import { browserLikeHeaders, createTimeoutSignal } from "./shared.js";

import type { YouTubeSourceDocument } from "../types.js";

export class YouTubeFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: "unreachable" | "blocked" | "timeout"
  ) {
    super(message);
    this.name = "YouTubeFetchError";
  }
}

const fetchTranscriptFromLibrary = async (videoId: string): Promise<string | null> => {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return null;
    }

    return transcript.map((entry) => entry.text).join(" ");
  } catch {
    return null;
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
  timeoutMs: number
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

    const timeout = createTimeoutSignal(timeoutMs);

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

      const xml = await response.text();
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

const parseChapterLines = (text: string): string[] =>
  text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^\d{1,2}:\d{2}(?::\d{2})?\s+/.test(line));

export const fetchYouTubeDocument = async (
  url: string,
  videoId: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number
): Promise<YouTubeSourceDocument> => {
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const oEmbedTimeout = createTimeoutSignal(timeoutMs);
  const oEmbedResponse = await fetchImplementation(oEmbedUrl, {
    headers: {
      "accept-language": browserLikeHeaders["accept-language"]
    },
    signal: oEmbedTimeout.signal
  }).finally(() => oEmbedTimeout.cleanup());

  if (!oEmbedResponse.ok) {
    throw new YouTubeFetchError(
      `Failed to fetch YouTube metadata: ${oEmbedResponse.status}`,
      oEmbedResponse.status === 403 || oEmbedResponse.status === 429 ? "blocked" : "unreachable"
    );
  }

  const metadata = (await oEmbedResponse.json()) as {
    title?: string;
    author_name?: string;
  };

  const watchTimeout = createTimeoutSignal(timeoutMs);
  const watchResponse = await fetchImplementation(url, {
    headers: browserLikeHeaders,
    signal: watchTimeout.signal
  }).finally(() => watchTimeout.cleanup());

  if (!watchResponse.ok) {
    throw new YouTubeFetchError(
      `Failed to fetch YouTube watch page: ${watchResponse.status}`,
      watchResponse.status === 403 || watchResponse.status === 429 ? "blocked" : "unreachable"
    );
  }

  const pageHtml = await watchResponse.text();
  const $ = load(pageHtml);
  const title =
    metadata.title ??
    $('meta[property="og:title"]').attr("content")?.trim() ??
    $("title").text().trim() ??
    null;
  const description =
    $('meta[property="og:description"]').attr("content")?.trim() ??
    $('meta[name="description"]').attr("content")?.trim() ??
    (metadata.author_name ? `Creator: ${metadata.author_name}` : null);
  const transcript =
    (await fetchTranscriptFromLibrary(videoId)) ??
    (await fetchTranscriptFromCaptionTrack(pageHtml, fetchImplementation, timeoutMs));
  const chapters = parseChapterLines(description ?? "");

  return {
    kind: "youtube",
    url,
    videoId,
    title,
    description,
    transcript,
    chapters,
    pageHtml
  };
};
