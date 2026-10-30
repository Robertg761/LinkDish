import {
  isHttpUrl,
  MAX_RECIPE_URL_LENGTH
} from "../../../../../../packages/recipe-domain/src/index.js";
import { isAbortError } from "../deadline.js";
import { parseHtmlDocument, type ParsedHtmlDocument } from "../html/parsed-html-document.js";
import {
  isFacebookHostname,
  parseFacebookLink,
  parseFacebookPost,
  unwrapFacebookRedirect
} from "../source-detection/parse-facebook-url.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { SocialFetchError } from "./errors.js";
import {
  createTimeoutSignal,
  identifyingFetchHeaders,
  isHtmlLikeContentType,
  readLimitedResponseText,
  ResponseBodyTooLargeError
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { TextSourceDocument } from "../types.js";

/*
 * A public Facebook post or reel answers a plain request with its Open Graph tags: the page name,
 * the caption (og:description) and the canonical URL. That is all LinkDish reads, and nothing is
 * logged in, rendered or scraped beyond the page head:
 *
 *   - The request identifies itself honestly (the LinkDishBot user-agent). Facebook answers a
 *     spoofed desktop browser with HTTP 400 and the honest agent with the real tags. It never
 *     poses as Facebook's own crawler or a search engine.
 *   - m., mbasic., web. and touch. hosts redirect to a login page, so every post is fetched from
 *     www.facebook.com.
 *   - A login wall, checkpoint, consent page, rate limit or a generic page with no post content
 *     is a "blocked" failure, so the person is sent to the paste-text or screenshot import.
 *
 * Facebook cuts og:description at about 200 characters and ends it with "...". Videos and reels
 * also carry their whole caption in og:title (as "<caption> | <page>") and in the oEmbed link's
 * title, so the longest of those is the caption. When only the cut text is available the document
 * says so (captionTruncated) and the orchestrator will not turn it into a recipe.
 *
 * Every hop of a redirect (fb.me, fb.watch and /share/ links resolve through redirects) is
 * validated like a user URL, and a redirect may only stay on Facebook.
 */
const pageMaxBytes = 2 * 1024 * 1024;
const maxRedirects = 6;
const maxCaptionChars = 5_000;
/* Facebook cuts og:description at about 200 characters. Anything this long that ends in an ellipsis was cut. */
const truncatedCaptionMinChars = 100;
const maxLinkedUrls = 6;

export interface FetchFacebookDocumentOptions {
  timeoutMs: number;
  /** The request deadline or a cancellation. */
  signal?: AbortSignal | undefined;
  validateUrl?: ValidateSourceUrl | undefined;
}

export interface FacebookPost {
  caption: string;
  /** The caption ends in "..." because Facebook cut it, and no fuller copy is on the page. */
  truncated: boolean;
  authorName: string | null;
  thumbnailUrl: string | null;
  isVideo: boolean | null;
  canonicalUrl: string | null;
  linkedUrls: string[];
}

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/*
 * Creators end lines with invisible separators to keep their blank lines; without them the
 * parser would see no gap between the ingredients and the method (same as Instagram).
 */
const cleanCaption = (caption: string): string =>
  caption
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u2063\u200b\u2060\ufeff\u2800]/gu, "")
    .replace(/\u00a0/gu, " ")
    .replace(/[^\S\n]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const endsWithEllipsis = (text: string): boolean => /(?:\.{3}|…)\s*$/u.test(text);

/*
 * Creators cut their own lists to tease the full recipe ("1/2 lb. chopped bacon..." then
 * "FULL RECIPE: <link>"). An ingredient or step line (one that starts with an amount, a bullet
 * or a step number) that ends in an ellipsis means the caption is a teaser, wherever it sits.
 */
const teaserLinePattern = /^\s*(?:[-•*]\s*)?(?:\d|[½¼¾⅓⅔⅛]).*(?:\.{3}|…)\s*$/u;

const hasTeaserLine = (text: string): boolean =>
  text.split("\n").some((line) => teaserLinePattern.test(line));

/* The copy of Facebook's login page, front page and error pages, which say nothing about a post. */
const genericPagePattern =
  /(?:log in or sign up|log in to facebook|log into facebook|sign up for facebook|create (?:a )?new account|facebook helps you connect|connect with friends, family|security check required|content (?:isn't|is not) available right now|this page isn't available)/iu;

const genericTitles = new Set([
  "facebook",
  "error",
  "log in or sign up",
  "log into facebook",
  "facebook - log in or sign up",
  "facebook – log in or sign up",
  "log in to facebook",
  "security check required",
  "this content isn't available right now",
  "content isn't available right now"
]);

const isGenericText = (text: string): boolean => {
  const lower = text.trim().toLowerCase();

  return genericTitles.has(lower) || (lower.length < 400 && genericPagePattern.test(lower));
};

/* "1.2K views", "56 reactions", "12,345 plays". */
const engagementCount = String.raw`[\d.,]+\s?[KkMmBb]?\s+(?:views?|reactions?|likes?|comments?|shares?|plays?)\b`;

/*
 * Facebook sometimes leads a description or a video's title with the counts:
 * "1.2K views · 56 reactions | caption".
 */
const engagementPrefixPattern = new RegExp(`^${engagementCount}[^|\\n]*\\|\\s*`, "iu");

/* A title that is only the counts and the page name leaves the counts where the caption would be. */
const engagementOnlyPattern = new RegExp(
  `^${engagementCount}(?:\\s*[·•,]\\s*${engagementCount})*$`,
  "iu"
);

const stripEngagementPrefix = (text: string): string => {
  let result = text;

  for (let pass = 0; pass < 3 && engagementPrefixPattern.test(result); pass += 1) {
    result = result.replace(engagementPrefixPattern, "");
  }

  return result;
};

/* A video's og:title is "<caption> | <page name>". */
const titleWithPagePattern = /^([\s\S]*\S)\s\|\s([^|\n]{1,100})$/u;

const jsonLdTextKeys = ["articleBody", "text", "caption", "description"] as const;

const collectJsonLdPosts = (
  value: unknown,
  found: { texts: string[]; authors: string[] },
  depth = 0
): void => {
  if (depth > 5) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 20)) {
      collectJsonLdPosts(entry, found, depth + 1);
    }

    return;
  }

  const record = readRecord(value);

  if (!record) {
    return;
  }

  for (const key of jsonLdTextKeys) {
    const text = readString(record[key]);

    if (text) {
      found.texts.push(text);
    }
  }

  const authors = Array.isArray(record.author) ? record.author : [record.author];

  for (const author of authors) {
    const name = readString(readRecord(author)?.name) ?? readString(author);

    if (name) {
      found.authors.push(name);
    }
  }

  collectJsonLdPosts(record["@graph"], found, depth + 1);
  collectJsonLdPosts(record.mainEntity, found, depth + 1);
  collectJsonLdPosts(record.sharedContent, found, depth + 1);
};

/*
 * Links the page shares to other sites. Facebook wraps every outbound link in
 * l.facebook.com/l.php?u=<target>; those are unwrapped, and Facebook's own pages are left out.
 */
const readLinkedUrls = (parsed: ParsedHtmlDocument): string[] => {
  const urls: string[] = [];
  const candidates = [
    ...parsed
      .$("a[href]")
      .toArray()
      .map((element) => parsed.$(element).attr("href")),
    parsed.metaContent("property", "og:see_also"),
    parsed.metaContent("property", "article:publisher")
  ];

  for (const href of candidates) {
    if (!href) {
      continue;
    }

    const link = parseFacebookLink(href);
    /* Only the l.php wrapper marks a link the post shared; bare Facebook links are navigation. */
    const target = link?.kind === "redirect" ? unwrapFacebookRedirect(href) : null;

    if (target && !parseFacebookLink(target) && isHttpUrl(target)) {
      urls.push(target);
    }
  }

  return [...new Set(urls)].slice(0, maxLinkedUrls);
};

/**
 * The post a Facebook page shows, or null when it shows none (a login wall, the front page, an
 * error page). The caption is the longest text among og:description, the meta and Twitter
 * descriptions, the caption in a video's og:title and oEmbed title, and any JSON-LD.
 */
export const readFacebookPost = (html: string): FacebookPost | null => {
  const parsed = parseHtmlDocument(html);
  const meta = (name: string): string | null =>
    readString(parsed.metaContent("property", name) ?? parsed.metaContent("name", name));
  const candidates: string[] = [];
  const pageNames: string[] = [];
  const jsonLd = { texts: [] as string[], authors: [] as string[] };

  for (const block of parsed.jsonLdBlocks) {
    collectJsonLdPosts(block, jsonLd);
  }

  const titles = [
    meta("og:title"),
    meta("twitter:title"),
    readString(parsed.$('link[rel="alternate"][type="application/json+oembed"]').attr("title"))
  ];

  for (const title of titles) {
    if (!title) {
      continue;
    }

    const withPage = title.match(titleWithPagePattern);

    if (withPage?.[1] && withPage[2]) {
      candidates.push(stripEngagementPrefix(withPage[1]));
      pageNames.push(withPage[2].trim());
    } else if (!title.includes("\n") && title.length <= 100) {
      pageNames.push(title);
    }
  }

  for (const description of [
    meta("og:description"),
    meta("twitter:description"),
    meta("description"),
    ...jsonLd.texts
  ]) {
    if (description) {
      candidates.push(stripEngagementPrefix(description));
    }
  }

  const caption = candidates
    .map(cleanCaption)
    .filter(
      (candidate) =>
        candidate.length > 0 && !isGenericText(candidate) && !engagementOnlyPattern.test(candidate)
    )
    .sort((left, right) => right.length - left.length)[0];

  if (!caption) {
    return null;
  }

  const authorName =
    [...jsonLd.authors, ...pageNames].find(
      (name) => !isGenericText(name) && !caption.startsWith(name)
    ) ?? null;
  const ogType = meta("og:type");
  const thumbnailUrl = meta("og:image") ?? meta("twitter:image");
  const canonicalUrl = meta("og:url") ?? readString(parsed.$('link[rel="canonical"]').attr("href"));

  return {
    caption,
    truncated:
      (caption.length >= truncatedCaptionMinChars && endsWithEllipsis(caption)) ||
      hasTeaserLine(caption),
    authorName,
    thumbnailUrl:
      thumbnailUrl && thumbnailUrl.length <= MAX_RECIPE_URL_LENGTH && isHttpUrl(thumbnailUrl)
        ? thumbnailUrl
        : null,
    isVideo: ogType ? /^video\b/iu.test(ogType) : null,
    canonicalUrl,
    linkedUrls: readLinkedUrls(parsed)
  };
};

/* Facebook sends logged-out visitors, rate-limited clients and unusual traffic to these. */
const isWallPath = (pathname: string): boolean =>
  /^\/(?:login|checkpoint|recover|two_step_verification|privacy\/consent|cookie\/consent|consent|ajax\/)/iu.test(
    pathname
  );

const classifyStatus = (status: number): SocialFetchError["reason"] =>
  status === 404 || status === 410
    ? "not_found"
    : status === 400 || status === 401 || status === 403 || status === 429
      ? "blocked"
      : "unreachable";

const assertSafe = async (url: string, validateUrl: ValidateSourceUrl): Promise<void> => {
  const safety = await validateUrl(url);

  if (isSourceUrlRejection(safety)) {
    throw new SocialFetchError(
      `Refused unsafe Facebook URL: ${safety.reason}`,
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

interface FetchedPage {
  html: string;
  finalUrl: string;
  statusCode: number;
}

/* Follows redirects by hand: every hop is validated, stays on Facebook and is not a login wall. */
const fetchPage = async (
  startUrl: string,
  fetchImplementation: typeof fetch,
  validateUrl: ValidateSourceUrl,
  signal: AbortSignal
): Promise<FetchedPage> => {
  let current = startUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafe(current, validateUrl);

    const response = await fetchImplementation(current, {
      headers: identifyingFetchHeaders,
      redirect: "manual",
      signal
    });
    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location) {
      discardBody(response);

      const next = unwrapFacebookRedirect(new URL(location, current).toString());
      const link = parseFacebookLink(next);

      if (!link || !isFacebookHostname(new URL(next).hostname)) {
        throw new SocialFetchError("Facebook link pointed outside Facebook.", "blocked");
      }

      if (isWallPath(new URL(next).pathname)) {
        throw new SocialFetchError("Facebook asked for a login.", "blocked", response.status);
      }

      if (link.kind === "redirect") {
        throw new SocialFetchError(
          "Facebook link redirected through too many wrappers.",
          "blocked"
        );
      }

      if (link.kind === "other") {
        throw new SocialFetchError("That Facebook link is not a post.", "not_found");
      }

      current = link.url;
      continue;
    }

    if (!response.ok) {
      discardBody(response);
      throw new SocialFetchError(
        `Facebook answered HTTP ${response.status}.`,
        classifyStatus(response.status),
        response.status
      );
    }

    if (!isHtmlLikeContentType(response.headers.get("content-type"))) {
      discardBody(response);
      throw new SocialFetchError(
        "Facebook did not return a web page.",
        "unsupported_content_type",
        response.status
      );
    }

    if (isWallPath(new URL(current).pathname)) {
      discardBody(response);
      throw new SocialFetchError("Facebook asked for a login.", "blocked", response.status);
    }

    return {
      html: await readLimitedResponseText(response, pageMaxBytes),
      finalUrl: current,
      statusCode: response.status
    };
  }

  throw new SocialFetchError("Facebook link redirected too many times.", "blocked");
};

const toCanonicalPostUrl = (canonicalUrl: string | null, fallbackUrl: string): string => {
  const link = canonicalUrl ? parseFacebookLink(canonicalUrl) : null;

  return link?.kind === "post" && link.url.length <= MAX_RECIPE_URL_LENGTH ? link.url : fallbackUrl;
};

export const fetchFacebookDocument = async (
  url: string,
  fetchImplementation: typeof fetch,
  options: FetchFacebookDocumentOptions
): Promise<TextSourceDocument> => {
  const link = parseFacebookPost(url);

  if (!link) {
    throw new SocialFetchError("That Facebook link is not a post.", "not_found");
  }

  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);

  try {
    const page = await fetchPage(link.url, fetchImplementation, validateUrl, timeout.signal);
    const post = readFacebookPost(page.html);

    if (!post) {
      throw new SocialFetchError(
        "Facebook showed no post content to a logged-out visitor.",
        "blocked",
        page.statusCode
      );
    }

    const pageLink = parseFacebookLink(page.finalUrl);
    const fallbackUrl =
      pageLink?.kind === "post" ? pageLink.url : link.kind === "post" ? link.url : page.finalUrl;
    const isVideo = post.isVideo ?? (pageLink?.kind === "post" ? pageLink.isVideo : false);

    return {
      kind: "text",
      /* The canonical /<page>/videos/<id> URL when Facebook names one, else the URL fetched. */
      url: toCanonicalPostUrl(post.canonicalUrl, fallbackUrl),
      origin: "facebook",
      text: post.caption.slice(0, maxCaptionChars),
      title: null,
      authorName: post.authorName,
      thumbnailUrl: post.thumbnailUrl,
      isVideo,
      /* A caption past LinkDish's own length cap is cut here, so it is partial too. */
      captionTruncated: post.truncated || post.caption.length > maxCaptionChars,
      linkedUrls: post.linkedUrls
    };
  } catch (error) {
    if (error instanceof SocialFetchError) {
      throw error;
    }

    if (error instanceof ResponseBodyTooLargeError) {
      throw new SocialFetchError("Facebook page was too large.", "too_large");
    }

    if (timeout.signal.aborted || isAbortError(error)) {
      throw new SocialFetchError(
        options.signal?.aborted && !timeout.timedOut()
          ? "Facebook request was cancelled or ran out of request time."
          : "Facebook request timed out.",
        "timeout"
      );
    }

    throw new SocialFetchError(
      error instanceof Error ? error.message : "Facebook request failed.",
      "unreachable"
    );
  } finally {
    timeout.cleanup();
  }
};
