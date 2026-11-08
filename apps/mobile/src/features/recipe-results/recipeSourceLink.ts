import { recipeSourceLabel } from "@linkdish/recipe-domain";

/**
 * Where a recipe came from, for the "From <site>" tile on the recipe screen. The Terms promise
 * "the original source one tap away", so a recipe saved from a real web page gets a tappable
 * link to its sourceUrl (the mobile twin of the web app's "Open the original recipe" chip).
 *
 * Photo scans, pasted text, recipes restored from other apps and starter recipes carry made-up
 * linkdish.app / linkdish.ca/starter URLs. Those are never linked: there is no page to open.
 */

const STARTER_URL_PATTERN = /^https?:\/\/(?:www\.)?linkdish\.ca\/starter\//iu;
const SYNTHETIC_URL_PATTERN = /^https?:\/\/(?:www\.)?linkdish\.app\//iu;

export interface RecipeSourceLink {
  /** "seriouseats.com", "Scanned image", "Pasted text", "LinkDish kitchen"… */
  label: string;
  /** The original page to open, or null when there is nothing real to link to. */
  href: string | null;
  /** "By <author>", when the source page named one. */
  byline: string | null;
}

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.replace(/\s+/gu, " ").trim();
  return trimmed ? trimmed : null;
};

export const getRecipeSourceLink = (
  sourceUrl: string | null | undefined,
  attribution: { author?: string | null | undefined; siteName?: string | null | undefined } = {}
): RecipeSourceLink => {
  if (!sourceUrl) {
    return { byline: null, href: null, label: "No source provided" };
  }

  if (STARTER_URL_PATTERN.test(sourceUrl)) {
    return { byline: null, href: null, label: "LinkDish kitchen" };
  }

  if (SYNTHETIC_URL_PATTERN.test(sourceUrl)) {
    return { byline: null, href: null, label: recipeSourceLabel(sourceUrl) };
  }

  const url = parseHttpUrl(sourceUrl);

  if (!url) {
    return { byline: null, href: null, label: recipeSourceLabel(sourceUrl) };
  }

  const author = clean(attribution.author);

  return {
    byline: author ? `By ${author}` : null,
    href: url.href,
    label: clean(attribution.siteName) ?? recipeSourceLabel(url.href)
  };
};
