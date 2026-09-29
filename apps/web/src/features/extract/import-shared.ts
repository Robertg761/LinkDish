import { isLikelySameRecipe } from "@linkdish/recipe-domain";

import { isImageImportSourceUrl } from "../recipe-view/recipe-source";

import type { WebSavedRecipe } from "../library/saved-recipe-types";

/** Pieces shared by the interactive importer and the import queue. */

/** routeOrScreen for import_* analytics (the importer lives at /import). */
export const IMPORT_ANALYTICS_ROUTE = "/import";

/** source_host for import analytics: the hostname without "www." (as it has always been). */
export const getAnalyticsSourceHost = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "") || undefined;
  } catch {
    return undefined;
  }
};

/** A saved recipe that is probably the same page (starters and photo scans never match). */
export const findSavedDuplicate = (
  url: string,
  recipes: readonly WebSavedRecipe[]
): WebSavedRecipe | undefined =>
  recipes.find(
    (recipe) =>
      !recipe.isStarter &&
      !isImageImportSourceUrl(recipe.sourceUrl) &&
      isLikelySameRecipe(url, recipe.sourceUrl)
  );
