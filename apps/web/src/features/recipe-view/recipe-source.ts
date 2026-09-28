import { recipeSourceLabel } from "@linkdish/recipe-domain";

import { getSyntheticImportLabel, isSyntheticImportUrl } from "../data-transfer/synthetic-url";

/**
 * Where a recipe came from, for the attribution chip, sharing and printing. Image imports carry
 * a synthetic https://linkdish.app/image-imports/… URL that must never be linked or shared.
 */

const IMAGE_IMPORT_URL_FRAGMENT = "linkdish.app/image-imports/";
const TEXT_IMPORT_URL_FRAGMENT = "linkdish.app/text-imports/";
const STARTER_URL_PATTERN = /^https?:\/\/(?:www\.)?linkdish\.ca\/starter\//iu;

export const isImageImportSourceUrl = (sourceUrl: string | null | undefined): boolean =>
  Boolean(sourceUrl?.includes(IMAGE_IMPORT_URL_FRAGMENT));

const parseHttpUrl = (value: string | null | undefined): URL | null => {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

export interface RecipeSourceInfo {
  /**
   * "seriouseats.com", "From your photos", "From pasted text", "Imported from Paprika",
   * "LinkDish kitchen" or "unknown".
   */
  label: string;
  /** A link to the original page, or null when there is nothing real to link to. */
  href: string | null;
  /** The URL that is safe to share or print (null for photo imports and starters). */
  shareUrl: string | null;
  kind: "web" | "photos" | "text" | "imported" | "starter" | "unknown";
}

export const getRecipeSourceInfo = (
  sourceUrl: string | null | undefined,
  options: { sourceHost?: string | null | undefined; isStarter?: boolean | undefined } = {}
): RecipeSourceInfo => {
  if (isImageImportSourceUrl(sourceUrl)) {
    return { href: null, kind: "photos", label: "From your photos", shareUrl: null };
  }

  // Pasted-text imports and recipes restored from other apps carry made-up linkdish.app URLs.
  if (sourceUrl?.includes(TEXT_IMPORT_URL_FRAGMENT)) {
    return { href: null, kind: "text", label: "From pasted text", shareUrl: null };
  }

  if (isSyntheticImportUrl(sourceUrl)) {
    return {
      href: null,
      kind: "imported",
      label: getSyntheticImportLabel(sourceUrl) ?? "Imported recipe",
      shareUrl: null
    };
  }

  // Starter recipes point at linkdish.ca/starter/…, which is not a real page.
  if (options.isStarter || (sourceUrl && STARTER_URL_PATTERN.test(sourceUrl))) {
    return { href: null, kind: "starter", label: "LinkDish kitchen", shareUrl: null };
  }

  const url = parseHttpUrl(sourceUrl);

  if (!url) {
    const host = options.sourceHost?.trim();
    return { href: null, kind: "unknown", label: host || "unknown", shareUrl: null };
  }

  return {
    href: url.href,
    kind: "web",
    label: options.sourceHost?.trim() || recipeSourceLabel(url.href),
    shareUrl: url.href
  };
};
