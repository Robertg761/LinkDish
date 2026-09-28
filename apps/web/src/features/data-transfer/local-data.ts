/**
 * Light reads for the Settings page: counts and the size of stored scans. All reads go through
 * the shared LinkDish database connection.
 */
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";

import type { WebRecipeSourceImagesRecord, WebSavedRecipe } from "../library/saved-recipe-types";

export interface SourceImageStats {
  recipes: number;
  images: number;
  /** Characters of base64 data URLs — about the bytes they add to a JSON backup. */
  bytes: number;
}

/**
 * How much the original scans would add to a backup (for `recipeIds`, or every recipe). Sizes
 * come from the recipe records, which note them when the scans are stored, so the scans
 * themselves (up to megabytes each) are not loaded. A recipe stored before sizes were noted has
 * its own scans read, one recipe at a time.
 */
export const measureSourceImages = async (
  recipeIds?: ReadonlySet<string>
): Promise<SourceImageStats> => {
  const db = await getLinkDishWebDb();
  const ids = recipeIds
    ? Array.from(recipeIds)
    : (await db.getAllKeys(RECIPE_SOURCE_IMAGES_STORE_NAME)).map(String);
  const stats: SourceImageStats = { recipes: 0, images: 0, bytes: 0 };

  for (const id of ids) {
    const recipe = (await db.get(SAVED_RECIPES_STORE_NAME, id)) as WebSavedRecipe | undefined;
    let images = recipe?.sourceImageCount ?? 0;
    let bytes = recipe?.sourceImageBytes;

    if (images > 0 && bytes === undefined) {
      const stored = (await db.get(RECIPE_SOURCE_IMAGES_STORE_NAME, id)) as
        | WebRecipeSourceImagesRecord
        | undefined;
      const scans = stored?.images ?? recipe?.sourceImages ?? [];
      images = scans.length;
      bytes = scans.reduce((sum, image) => sum + image.dataUrl.length, 0);
    }

    if (images > 0) {
      stats.recipes += 1;
      stats.images += images;
      stats.bytes += bytes ?? 0;
    }
  }

  return stats;
};

export interface LocalDataCounts {
  /** Personal recipes (starter recipes excluded). */
  recipes: number;
  starters: number;
  collections: number;
  mealPlanEntries: number;
}

export const readLocalDataCounts = async (): Promise<LocalDataCounts> => {
  const db = await getLinkDishWebDb();
  const [keys, collections, mealPlanEntries] = await Promise.all([
    db.getAllKeys(SAVED_RECIPES_STORE_NAME),
    db.count(COLLECTIONS_STORE_NAME),
    db.count(MEAL_PLAN_STORE_NAME)
  ]);
  const starters = keys.filter(
    (key) => typeof key === "string" && key.startsWith("starter-")
  ).length;

  return { recipes: keys.length - starters, starters, collections, mealPlanEntries };
};
