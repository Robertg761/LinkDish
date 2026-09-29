/**
 * Recipes imported from another app without a web address get a stable, synthetic source URL
 * so the deterministic saved-recipe id (SHA-256 of sourceUrl + title) and duplicate detection
 * keep working: `https://linkdish.app/imports/<app>/<slug>-<hash>` — the exact shape the
 * @linkdish/recipe-domain importers produce (paprika, mela, schema-org).
 *
 * These URLs do not point at a real page. Screens should treat them like photo imports
 * (`https://linkdish.app/image-imports/…`): show a label instead of a link. This module has no
 * dependencies so pages can import it without pulling in the import code.
 */

export const SYNTHETIC_IMPORT_URL_PREFIX = "https://linkdish.app/imports/";
export const IMAGE_IMPORT_URL_PREFIX = "https://linkdish.app/image-imports/";
/** Pasted-text imports (`https://linkdish.app/text-imports/web-<time>-<uuid>`). */
export const TEXT_IMPORT_URL_PREFIX = "https://linkdish.app/text-imports/";

const IMPORT_APP_LABELS: Record<string, string> = {
  linkdish: "a LinkDish backup",
  mela: "Mela",
  paprika: "Paprika"
};

/** True for the synthetic URL given to imported recipes that had no web address. */
export const isSyntheticImportUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" && url.startsWith(SYNTHETIC_IMPORT_URL_PREFIX);

/**
 * True for any LinkDish-made source URL (synthetic, photo and pasted-text imports): never link
 * it, and never treat two of them as the same page unless they are the same URL.
 */
export const isLinkDishInternalSourceUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" &&
  (url.startsWith(SYNTHETIC_IMPORT_URL_PREFIX) ||
    url.startsWith(IMAGE_IMPORT_URL_PREFIX) ||
    url.startsWith(TEXT_IMPORT_URL_PREFIX));

/**
 * A short, human label for where an imported recipe came from ("Imported from Paprika"), or
 * null when the URL is not a synthetic import URL.
 */
export const getSyntheticImportLabel = (url: string | null | undefined): string | null => {
  if (!isSyntheticImportUrl(url)) {
    return null;
  }

  const app = (url ?? "").slice(SYNTHETIC_IMPORT_URL_PREFIX.length).split("/")[0] ?? "";
  const label = IMPORT_APP_LABELS[app];
  return label ? `Imported from ${label}` : "Imported recipe";
};
