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

import type { WebRecipeSourceImagesRecord } from "../library/saved-recipe-types";

export interface SourceImageStats {
  recipes: number;
  images: number;
  /** Characters of base64 data URLs — about the bytes they add to a JSON backup. */
  bytes: number;
}

/** How much the original scans would add to a backup. */
export const measureSourceImages = async (
  recipeIds?: ReadonlySet<string>
): Promise<SourceImageStats> => {
  const db = await getLinkDishWebDb();
  const records = (await db.getAll(
    RECIPE_SOURCE_IMAGES_STORE_NAME
  )) as WebRecipeSourceImagesRecord[];
  const stats: SourceImageStats = { recipes: 0, images: 0, bytes: 0 };

  for (const record of records) {
    if (!record.images?.length || (recipeIds && !recipeIds.has(record.recipeId))) {
      continue;
    }

    stats.recipes += 1;
    stats.images += record.images.length;
    stats.bytes += record.images.reduce((sum, image) => sum + image.dataUrl.length, 0);
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
