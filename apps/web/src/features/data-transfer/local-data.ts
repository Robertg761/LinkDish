/**
 * Reads for the "Your data" tools: the export snapshot, original scans, counts, and the size of
 * stored scans. All reads go through the shared LinkDish database connection.
 */
import { getCollections } from "../../data/collections-store";
import { getMealPlanEntries } from "../../data/meal-plan-store";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { getSavedRecipes } from "../library/saved-recipe-store";

import type { ExportSnapshot } from "./backup-export";
import type { WebRecipeSourceImagesRecord, WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";

export const loadExportSnapshot = async (): Promise<ExportSnapshot> => {
  const [recipes, collections, mealPlan] = await Promise.all([
    getSavedRecipes(),
    getCollections(),
    getMealPlanEntries()
  ]);

  return { recipes, collections, mealPlan };
};

/** Original scans for the given recipes (records written before v4 embed them). */
export const loadSourceImages = async (
  recipes: readonly WebSavedRecipe[]
): Promise<Map<string, ExtractRecipeImage[]>> => {
  const db = await getLinkDishWebDb();
  const wanted = new Set(recipes.map((recipe) => recipe.id));
  const records = (await db.getAll(
    RECIPE_SOURCE_IMAGES_STORE_NAME
  )) as WebRecipeSourceImagesRecord[];
  const images = new Map<string, ExtractRecipeImage[]>();

  for (const record of records) {
    if (wanted.has(record.recipeId) && record.images?.length) {
      images.set(record.recipeId, record.images);
    }
  }

  return images;
};

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
