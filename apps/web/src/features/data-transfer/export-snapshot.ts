/** Reads everything a backup needs from this device (loaded with the export code, on demand). */
import { getCollections } from "../../data/collections-store";
import { getMealPlanEntries } from "../../data/meal-plan-store";
import { getLinkDishWebDb, RECIPE_SOURCE_IMAGES_STORE_NAME } from "../../storage/linkdish-db";
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

/** Original scans for the given recipes. */
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
