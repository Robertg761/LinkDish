import { MAX_EXTRACT_TEXT_CHARS, MIN_EXTRACT_TEXT_CHARS } from "@linkdish/api-contracts";
import { canonicalizeRecipeUrl, extractFirstUrl } from "@linkdish/recipe-domain";

/**
 * Pasted recipe text (a caption, a note, an email): checking it before it is sent, and holding
 * it in memory while the recipe screen reads it, the way scans are held (see
 * pendingImageImports).
 */

export const MIN_IMPORT_TEXT_CHARS = MIN_EXTRACT_TEXT_CHARS;
export const MAX_IMPORT_TEXT_CHARS = MAX_EXTRACT_TEXT_CHARS;
/** Mirrors the length limit of httpUrlSchema in @linkdish/recipe-domain. */
const MAX_API_LINK_LENGTH = 2_048;

/** Every text import's route key starts with this (the API never sees it). */
export const TEXT_IMPORT_URL_PREFIX = "https://linkdish.app/text-imports/";

export type TextInputProblem = "too_short" | "too_long" | null;

/** Characters that count toward the limit (the API trims before measuring). */
export const measureImportText = (text: string): number => text.trim().length;

export const getTextInputProblem = (text: string): TextInputProblem => {
  const length = measureImportText(text);

  if (length < MIN_IMPORT_TEXT_CHARS) {
    return "too_short";
  }

  return length > MAX_IMPORT_TEXT_CHARS ? "too_long" : null;
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
 * The page a pasted caption came from: its one written-out link, as the web importer sends it.
 * There is none when the text has several links or the API wouldn't take it.
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

/** The text is really just a link (with a few words around it at most): import it as one. */
export const getOnlyLink = (text: string): string | undefined => {
  const trimmed = text.trim();
  const link = extractFirstUrl(trimmed);
  return link && trimmed.length <= link.length + 12 ? link : undefined;
};

export interface PendingTextImport {
  id: string;
  /** The caption's own link, sent as the recipe's source. */
  captionSourceUrl?: string | undefined;
  /** The route's key for this import; never sent. */
  sourceUrl: string;
  text: string;
}

const pendingTextImports = new Map<string, PendingTextImport>();

export const createPendingTextImport = (text: string): PendingTextImport => {
  const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const trimmed = text.trim();
  const captionSourceUrl = findCaptionSourceUrl(trimmed);
  const pendingImport: PendingTextImport = {
    id,
    sourceUrl: `${TEXT_IMPORT_URL_PREFIX}android-${id}`,
    text: trimmed,
    ...(captionSourceUrl ? { captionSourceUrl } : {})
  };

  pendingTextImports.set(id, pendingImport);
  return pendingImport;
};

export const getPendingTextImport = (id: string): PendingTextImport | undefined =>
  pendingTextImports.get(id);

export const removePendingTextImport = (id: string): void => {
  pendingTextImports.delete(id);
};
