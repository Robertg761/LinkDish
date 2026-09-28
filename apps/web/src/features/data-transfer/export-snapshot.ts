/** Reads everything a backup needs from this device (loaded with the export code, on demand). */
import { sortCollections } from "../../data/collections-store";
import { compareMealPlanEntries } from "../../data/meal-plan-store";
import { runLinkDishTransaction } from "../../storage/idb-transaction";
import {
  COLLECTIONS_STORE_NAME,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { toSavedRecipeList } from "../library/saved-recipe-store";

import { selectExportRecipes } from "./export-selection";

import type { ExportSnapshot } from "./backup-export";
import type { WebCollection } from "../../data/collections-store";
import type { MealPlanEntry } from "../../data/meal-plan-store";
import type { WebRecipeSourceImagesRecord, WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";

export interface LoadedExport extends ExportSnapshot {
  /** Original scans by recipe id, for the recipes a backup includes (with `includeImages`). */
  sourceImages?: Map<string, ExtractRecipeImage[]> | undefined;
}

const COOKBOOK_STORES = [
  SAVED_RECIPES_STORE_NAME,
  COLLECTIONS_STORE_NAME,
  MEAL_PLAN_STORE_NAME
] as const;

/**
 * The scans of the recipes a backup includes: from the scans store, or still inside the recipe
 * record when it was saved before scans had their own store and has not been moved yet.
 */
const collectSourceImages = (
  recipes: readonly WebSavedRecipe[],
  records: readonly WebSavedRecipe[],
  imageRecords: readonly WebRecipeSourceImagesRecord[]
): Map<string, ExtractRecipeImage[]> => {
  const wanted = new Set(selectExportRecipes(recipes).map((recipe) => recipe.id));
  const images = new Map<string, ExtractRecipeImage[]>();

  for (const record of imageRecords) {
    if (wanted.has(record.recipeId) && record.images?.length) {
      images.set(record.recipeId, record.images);
    }
  }

  for (const record of records) {
    if (wanted.has(record.id) && !images.has(record.id) && record.sourceImages?.length) {
      images.set(record.id, record.sourceImages);
    }
  }

  return images;
};

/**
 * Reads the recipes, collections and meal plan (and, with `includeImages`, the scans of the
 * recipes a backup includes) in ONE readonly transaction, so a backup is the cookbook at one
 * moment: an edit another tab saves meanwhile (a new version of a recipe with new scans, a
 * deleted collection) is in it completely or not at all.
 */
export const loadExportSnapshot = async (
  options: { includeImages?: boolean | undefined } = {}
): Promise<LoadedExport> => {
  const includeImages = options.includeImages === true;
  const [records, collections, mealPlan, imageRecords] = await runLinkDishTransaction(
    includeImages ? [...COOKBOOK_STORES, RECIPE_SOURCE_IMAGES_STORE_NAME] : COOKBOOK_STORES,
    "readonly",
    (tx) =>
      Promise.all([
        tx.objectStore(SAVED_RECIPES_STORE_NAME).getAll() as Promise<WebSavedRecipe[]>,
        tx.objectStore(COLLECTIONS_STORE_NAME).getAll() as Promise<WebCollection[]>,
        tx.objectStore(MEAL_PLAN_STORE_NAME).getAll() as Promise<MealPlanEntry[]>,
        includeImages
          ? (tx.objectStore(RECIPE_SOURCE_IMAGES_STORE_NAME).getAll() as Promise<
              WebRecipeSourceImagesRecord[]
            >)
          : undefined
      ])
  );
  const recipes = toSavedRecipeList(records);
  const snapshot: LoadedExport = {
    recipes,
    collections: sortCollections(collections),
    mealPlan: [...mealPlan].sort(compareMealPlanEntries)
  };

  return imageRecords
    ? { ...snapshot, sourceImages: collectSourceImages(recipes, records, imageRecords) }
    : snapshot;
};
