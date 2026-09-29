import { canonicalizeRecipeUrl, extractFirstUrl } from "@linkdish/recipe-domain";

/**
 * Reading what people paste into the importer: one link (with or without https://, with a
 * sentence around it or trailing punctuation), several links at once, or recipe text.
 */

/** Mirrors MIN_EXTRACT_TEXT_CHARS / MAX_EXTRACT_TEXT_CHARS in @linkdish/api-contracts. */
export const MIN_IMPORT_TEXT_CHARS = 20;
export const MAX_IMPORT_TEXT_CHARS = 20_000;
/** Mirrors MAX_IMAGE_EXTRACT_COUNT in @linkdish/api-contracts. */
export const MAX_IMPORT_PHOTOS = 4;
/** More than this in one paste is almost certainly not a list of recipes. */
export const MAX_BATCH_LINKS = 25;
/** Mirrors the length limit of httpUrlSchema in @linkdish/recipe-domain. */
const MAX_API_LINK_LENGTH = 2_048;

/** "seriouseats.com/recipe", "m.allrecipes.com/x?y=1" — a host with a dot and an optional path. */
const BARE_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#][^\s]*)?$/iu;
const TRAILING_PUNCTUATION_PATTERN = /[),.!?;:\]'"]+$/u;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

const toHttpUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export type LinkInputResult =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "not_a_link" | "unsupported_scheme" };

/**
 * The recipe link in whatever was typed or pasted: share text ("Look! https://x.com/r)."),
 * scheme-less addresses ("www.site.com/r", "site.com/r") and plain URLs.
 */
export const parseRecipeLinkInput = (input: string): LinkInputResult => {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }

  const fromText = extractFirstUrl(trimmed);

  if (fromText) {
    return { ok: true, url: fromText };
  }

  const firstToken = (trimmed.split(/\s+/u)[0] ?? "").replace(TRAILING_PUNCTUATION_PATTERN, "");

  if (SCHEME_PATTERN.test(firstToken) && !/^https?:/iu.test(firstToken)) {
    return { ok: false, reason: "unsupported_scheme" };
  }

  if (BARE_HOST_PATTERN.test(firstToken)) {
    const url = toHttpUrl(`https://${firstToken}`);

    if (url) {
      return { ok: true, url };
    }
  }

  return { ok: false, reason: "not_a_link" };
};

/**
 * Every distinct link in a paste (one per line, or separated by spaces), in order. Duplicates
 * (after tracking parameters are ignored) are dropped.
 */
export const parseLinkList = (input: string): string[] => {
  const seen = new Set<string>();
  const links: string[] = [];

  for (const token of input.split(/\s+/u)) {
    if (!token) {
      continue;
    }

    const parsed = parseRecipeLinkInput(token);

    if (!parsed.ok) {
      continue;
    }

    const key = canonicalizeRecipeUrl(parsed.url);

    if (!seen.has(key)) {
      seen.add(key);
      links.push(parsed.url);
    }

    if (links.length >= MAX_BATCH_LINKS) {
      break;
    }
  }

  return links;
};

/** Whether the API takes this as a link (httpUrlSchema): http(s), no sign-in in it, not too long. */
const isApiLink = (value: string): boolean => {
  if (value.length > MAX_API_LINK_LENGTH) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

/**
 * The page a pasted caption came from: its one written-out link (https://… or www.…), as the
 * importer sends it. A bare "word.word" doesn't count ("…a pinch of salt.Enjoy!" is a missing
 * space, not a site), and there is none when it has several links or the API wouldn't take it.
 */
export const findCaptionSourceUrl = (text: string): string | undefined => {
  const links = new Map<string, string>();

  for (const token of text.split(/\s+/u)) {
    const url = token ? extractFirstUrl(token) : null;
    const key = url ? canonicalizeRecipeUrl(url) : null;

    if (url && key && !links.has(key)) {
      links.set(key, url);
    }

    if (links.size > 1) {
      return undefined;
    }
  }

  const [only] = links.values();
  return only && isApiLink(only) ? only : undefined;
};

/** "seriouseats.com" for a link, without www./m. */
export const getImportHost = (url: string | null | undefined): string | null => {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).hostname.toLowerCase().replace(/^(?:www\d?|m|mobile)\./u, "");
  } catch {
    return null;
  }
};

const SOCIAL_HOST_PATTERN =
  /(?:^|\.)(?:tiktok\.com|instagram\.com|facebook\.com|fb\.watch|threads\.net|pinterest\.[a-z.]+|pin\.it|x\.com|twitter\.com)$/u;

/**
 * Social posts (TikTok, Instagram, Pinterest, Facebook, YouTube Shorts…) keep the recipe in a
 * caption or the video itself, which only the AI reader can pull out.
 */
export const isSocialImportUrl = (url: string | null | undefined): boolean => {
  const host = getImportHost(url);

  if (!host) {
    return false;
  }

  if (SOCIAL_HOST_PATTERN.test(host)) {
    return true;
  }

  try {
    return (
      /(?:^|\.)youtube\.com$/u.test(host) && new URL(url ?? "").pathname.startsWith("/shorts/")
    );
  } catch {
    return false;
  }
};

/** Characters that count toward the text limit (the API trims before measuring). */
export const measureImportText = (text: string): number => text.trim().length;

export type TextInputProblem = "too_short" | "too_long" | null;

export const getTextInputProblem = (text: string): TextInputProblem => {
  const length = measureImportText(text);

  if (length < MIN_IMPORT_TEXT_CHARS) {
    return "too_short";
  }

  return length > MAX_IMPORT_TEXT_CHARS ? "too_long" : null;
};

/** Photo imports carry a synthetic source URL that is never shown or linked. */
export const createImageImportSourceUrl = (): string =>
  `https://linkdish.app/image-imports/web-${Date.now()}-${crypto.randomUUID()}`;

/** Pasted-text imports get their own synthetic source so the saved id stays unique. */
export const createTextImportSourceUrl = (): string =>
  `https://linkdish.app/text-imports/web-${Date.now()}-${crypto.randomUUID()}`;
