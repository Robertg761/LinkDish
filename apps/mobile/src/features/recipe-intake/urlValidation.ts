import { extractFirstUrl } from "@linkdish/recipe-domain";

export const INVALID_RECIPE_URL_MESSAGE = "Enter a complete URL, including http:// or https://.";

export const isAllowedRecipeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The recipe URL in what someone pasted into the link field: the text itself when it is a
 * URL, otherwise the first link inside it (TikTok and Instagram captions paste as a sentence
 * with the link somewhere in it). Returns null when there is no usable link.
 */
export const resolveRecipeUrlInput = (value: string): string | null => {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (isAllowedRecipeUrl(trimmed)) {
    return trimmed;
  }

  return extractFirstUrl(trimmed);
};
