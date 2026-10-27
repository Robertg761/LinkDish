import { isHttpUrl } from "../../../../../../packages/recipe-domain/src/index.js";
import { htmlFragmentToText } from "../extractors/html-text.js";
import { findJsonStringValues, readJsonStringLiteral } from "../html/json-string-literal.js";
import { getParsedHtmlDocument } from "../html/parsed-html-document.js";
import { parseInstagramPost } from "../source-detection/detect-source-from-url.js";

import { BrowserFetchError, SocialFetchError } from "./errors.js";

import type { FetchResult, HtmlSourceDocument, TextSourceDocument } from "../types.js";

/*
 * Instagram answers a plain server request for a post, or for its embed page, with a logged-out
 * app shell that has no caption in it. The public embed page (the one other sites put in an
 * iframe) does carry the caption once a real browser loads it, so the caption is read from that
 * page rendered by the browser fetcher. Meta's official oEmbed API no longer returns captions
 * (November 2025), so it is not an option.
 *
 * The page is read in order of how specific the data is: the post's record in the page state,
 * the classic embed markup (.Caption), then the rendered text between the post's like count and
 * its comments link.
 */
export const INSTAGRAM_ORIGIN = "https://www.instagram.com";

const maxCaptionChars = 5_000;

/*
 * Instagram drops empty lines from captions, so creators end lines with an invisible separator
 * (U+2063) to keep them. Without it those lines are empty again, and the text parser sees the
 * gap between the ingredients and the method.
 */
const cleanCaption = (caption: string): string =>
  caption
    .replace(/[\u2063\u200b\u2060\ufeff]/gu, "")
    .replace(/[^\S\n]+$/gmu, "")
    .trim();

/** Renders a page with the browser fetcher (the runtime supplies it with the request's budget). */
export type RenderInstagramPage = (url: string) => Promise<FetchResult>;

export interface InstagramEmbedPost {
  caption: string;
  authorName: string | null;
  thumbnailUrl: string | null;
  isVideo: boolean | null;
}

export const toInstagramPostUrl = (shortcode: string, isVideo: boolean): string =>
  `${INSTAGRAM_ORIGIN}/${isVideo ? "reel" : "p"}/${shortcode}/`;

/* Reels and IGTV videos have the same embed page as photo posts, under /p/. */
export const toInstagramEmbedUrl = (shortcode: string): string =>
  `${INSTAGRAM_ORIGIN}/p/${shortcode}/embed/captioned/`;

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readImageUrl = (value: unknown): string | null => {
  const url = readString(value);
  return url && isHttpUrl(url) ? url : null;
};

/* Both shapes Instagram has used for a post's caption: GraphQL edges and the v1 media record. */
const readMediaCaption = (media: Record<string, unknown>): string | null => {
  const edges = readRecord(media.edge_media_to_caption)?.edges;
  const firstEdge = Array.isArray(edges) ? readRecord(edges[0]) : null;

  return (
    readString(readRecord(firstEdge?.node)?.text) ?? readString(readRecord(media.caption)?.text)
  );
};

const readMediaPost = (media: Record<string, unknown>): InstagramEmbedPost | null => {
  const caption = readMediaCaption(media);
  const owner = readRecord(media.owner) ?? readRecord(media.user);
  const authorName = readString(owner?.username);

  if (!caption && !authorName) {
    return null;
  }

  const isVideo =
    typeof media.is_video === "boolean"
      ? media.is_video
      : typeof media.media_type === "number"
        ? media.media_type === 2
        : null;

  return {
    caption: caption ?? "",
    authorName,
    thumbnailUrl: readImageUrl(media.display_url) ?? readImageUrl(media.thumbnail_src),
    isVideo
  };
};

const isMediaRecord = (record: Record<string, unknown>): boolean =>
  "edge_media_to_caption" in record ||
  (("shortcode" in record || "code" in record) && ("caption" in record || "owner" in record));

/* Breadth-first, bounded: the post's record sits a few levels down in the page state. */
const findMediaPost = (root: unknown, shortcode: string): InstagramEmbedPost | null => {
  const queue: unknown[] = [root];
  let visited = 0;

  while (queue.length > 0 && visited < 5_000) {
    const value = queue.shift();
    visited += 1;

    if (Array.isArray(value)) {
      queue.push(...(value as unknown[]));
      continue;
    }

    const record = readRecord(value);

    if (!record) {
      continue;
    }

    const code = readString(record.shortcode) ?? readString(record.code);

    if (isMediaRecord(record) && (!code || code === shortcode)) {
      const post = readMediaPost(record);

      if (post) {
        return post;
      }
    }

    queue.push(...Object.values(record));
  }

  return null;
};

/* The embed page's state: a JSON-encoded "contextJSON" string, or a bare caption edge in a script. */
const readPostFromPageState = (html: string, shortcode: string): InstagramEmbedPost | null => {
  for (const contextJson of findJsonStringValues(html, "contextJSON", 3)) {
    try {
      const post = findMediaPost(JSON.parse(contextJson) as unknown, shortcode);

      if (post) {
        return post;
      }
    } catch {
      continue;
    }
  }

  const marker = '"edge_media_to_caption":{"edges":[{"node":{"text":';
  const markerIndex = html.indexOf(marker);
  const caption =
    markerIndex === -1 ? null : readJsonStringLiteral(html, markerIndex + marker.length);

  if (caption?.trim()) {
    const ownerIndex = html.indexOf('"owner":{', markerIndex);
    const ownerName =
      ownerIndex === -1
        ? null
        : findJsonStringValues(html.slice(ownerIndex, ownerIndex + 2_000), "username", 1)[0];

    return {
      caption: caption.trim(),
      authorName: readString(ownerName),
      thumbnailUrl: readImageUrl(findJsonStringValues(html, "display_url", 1)[0]),
      isVideo: null
    };
  }

  return null;
};

/* The classic embed markup: the username, then the caption, then a link to the comments. */
const readPostFromCaptionMarkup = (document: HtmlSourceDocument): InstagramEmbedPost | null => {
  const { $ } = getParsedHtmlDocument(document);
  const captionElement = $(".Caption").first();

  if (captionElement.length === 0) {
    return null;
  }

  const copy = captionElement.clone();
  const authorName =
    readString(copy.find(".CaptionUsername").first().text()) ??
    readString($(".UsernameText").first().text());

  copy.find(".CaptionUsername, .CaptionComments").remove();

  return {
    caption: htmlFragmentToText(copy.html() ?? "", { preserveLines: true }),
    authorName,
    thumbnailUrl: readImageUrl($("img.EmbeddedMediaImage").first().attr("src")),
    isVideo: $(".EmbedIsVideo, .VideoIcon").length > 0 ? true : null
  };
};

const likesLinePattern = /^(?:[\d.,]+[KkMm]?\s+likes?|Liked by\b.*)$/u;
const commentsLinePattern =
  /^(?:View all [\d.,]+[KkMm]? comments?|View \d+ more comments?|Add a comment\.{0,3}|View more on Instagram)$/iu;

/*
 * The rendered page reads: the author's header, the like count, the author's username on its
 * own line, the caption, then "View all 10 comments" and "Add a comment...".
 */
const readPostFromRenderedText = (document: HtmlSourceDocument): InstagramEmbedPost | null => {
  const { $ } = getParsedHtmlDocument(document);
  const body = $("body").clone();

  body.find("script, style, noscript, template, svg").remove();

  const lines = htmlFragmentToText(body.html() ?? "", { preserveLines: true })
    .split("\n")
    .map((line) => line.trim());
  const likesIndex = lines.findIndex((line) => likesLinePattern.test(line));

  if (likesIndex === -1) {
    return null;
  }

  const authorName = readString(lines[likesIndex + 1]);
  const captionLines: string[] = [];

  for (const line of lines.slice(likesIndex + 2)) {
    if (commentsLinePattern.test(line)) {
      return authorName
        ? {
            caption: captionLines.join("\n").trim(),
            authorName,
            thumbnailUrl: null,
            isVideo: null
          }
        : null;
    }

    captionLines.push(line);
  }

  return null;
};

/* The embed page of a removed, private or mistyped post says so instead of showing one. */
const removedPostPattern =
  /(?:may be broken, or the post may have been removed|Sorry, this page isn't available|This (?:post|content|reel) (?:is|isn't) (?:no longer )?available|Post isn't available)/iu;

/** The post a rendered embed page shows, or null when it shows no post. */
export const readInstagramEmbedPost = (
  document: HtmlSourceDocument,
  shortcode: string
): InstagramEmbedPost | null =>
  readPostFromPageState(document.html, shortcode) ??
  readPostFromCaptionMarkup(document) ??
  readPostFromRenderedText(document);

export const fetchInstagramDocument = async (
  url: string,
  renderPage: RenderInstagramPage
): Promise<TextSourceDocument> => {
  const post = parseInstagramPost(url);

  if (!post) {
    throw new SocialFetchError("That Instagram link is not a post.", "not_found");
  }

  let result: FetchResult;

  try {
    result = await renderPage(toInstagramEmbedUrl(post.shortcode));
  } catch (error) {
    if (error instanceof BrowserFetchError) {
      throw new SocialFetchError(error.message, error.reason, error.statusCode);
    }

    throw error;
  }

  const { document } = result;

  if (/\/accounts\/login\b/u.test(new URL(document.finalUrl).pathname)) {
    throw new SocialFetchError("Instagram asked for a login.", "blocked", document.statusCode);
  }

  const embedPost = readInstagramEmbedPost(document, post.shortcode);

  if (!embedPost) {
    const removed = removedPostPattern.test(getParsedHtmlDocument(document).bodyText);

    throw new SocialFetchError(
      removed
        ? "That Instagram post is private or removed."
        : "The Instagram embed page showed no post.",
      removed ? "not_found" : "blocked",
      document.statusCode
    );
  }

  const isVideo = embedPost.isVideo ?? post.isVideo;

  return {
    kind: "text",
    url: toInstagramPostUrl(post.shortcode, isVideo),
    origin: "instagram",
    text: cleanCaption(embedPost.caption).slice(0, maxCaptionChars),
    title: null,
    authorName: embedPost.authorName,
    thumbnailUrl: embedPost.thumbnailUrl,
    isVideo
  };
};
