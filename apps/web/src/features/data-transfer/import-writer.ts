/**
 * Writes an import in ONE IndexedDB transaction across saved recipes, their scans, collections
 * and the meal plan, so a restore either lands completely or not at all. The plan is rebuilt
 * inside the transaction from freshly read state, so the free limit, id collisions and which
 * starters may be replaced are checked against what is really stored (another tab may have saved
 * something, or made a starter its own, since the preview).
 */
import { emitDataChange } from "../../data/change-feed";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { toSavedRecipeListRecord } from "../library/saved-recipe-store";

import { DataTransferError, isStorageFullError } from "./errors";
import { buildImportPlan, isUntouchedStarter } from "./import-plan";

import type { DuplicateMode, ImportAnalysis, ImportPlan } from "./import-plan";
import type { ImportProgress } from "./import-sources";
import type { WebCollection } from "../../data/collections-store";
import type { MealPlanEntry } from "../../data/meal-plan-store";
import type { WebRecipeSourceImagesRecord, WebSavedRecipe } from "../library/saved-recipe-types";

const STARTER_ID_PREFIX = "starter-";

export interface CommitImportOptions {
  duplicateMode: DuplicateMode;
  isPremium: boolean;
  onProgress?: ((progress: ImportProgress) => void) | undefined;
  now?: (() => string) | undefined;
  createId?: (() => string) | undefined;
}

export interface ImportResult {
  plan: ImportPlan;
  /** Ids of the recipes written (new and restored). */
  recipeIds: string[];
}

const defaultCreateId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Commits an analyzed import. Resolves with what was written; rejects with a
 * {@link DataTransferError} (nothing is written) when storage is full or unavailable.
 */
export async function commitImport(
  analysis: ImportAnalysis,
  options: CommitImportOptions
): Promise<ImportResult> {
  let db;

  try {
    db = await getLinkDishWebDb();
  } catch {
    throw new DataTransferError("storage_unavailable");
  }

  const stores = [
    SAVED_RECIPES_STORE_NAME,
    RECIPE_SOURCE_IMAGES_STORE_NAME,
    COLLECTIONS_STORE_NAME,
    MEAL_PLAN_STORE_NAME
  ];
  const tx = db.transaction(stores, "readwrite");
  // Failures surface through the awaited requests; keep `done` from becoming unhandled.
  const done = tx.done;
  done.catch(() => undefined);

  const recipesStore = tx.objectStore(SAVED_RECIPES_STORE_NAME);
  const imagesStore = tx.objectStore(RECIPE_SOURCE_IMAGES_STORE_NAME);
  const collectionsStore = tx.objectStore(COLLECTIONS_STORE_NAME);
  const mealPlanStore = tx.objectStore(MEAL_PLAN_STORE_NAME);
  const written: WebSavedRecipe[] = [];
  const membershipUpdates: WebSavedRecipe[] = [];
  let plan: ImportPlan;

  try {
    const keys = (await recipesStore.getAllKeys()).map(String);
    const existingRecipeIds = new Set(keys);
    const existingCollections = (await collectionsStore.getAll()) as WebCollection[];
    const existingMealPlan = (await mealPlanStore.getAll()) as MealPlanEntry[];
    // The starters in the file as stored now: one someone made their own is kept.
    const starterIds = new Set(
      analysis.items.flatMap((item) =>
        item.starterId && existingRecipeIds.has(item.starterId) ? [item.starterId] : []
      )
    );
    const storedStarters = await Promise.all(
      Array.from(starterIds, (id) => recipesStore.get(id) as Promise<WebSavedRecipe | undefined>)
    );

    plan = buildImportPlan(analysis, {
      duplicateMode: options.duplicateMode,
      isPremium: options.isPremium,
      existingRecipeIds,
      quotaUsed: keys.filter((key) => !key.startsWith(STARTER_ID_PREFIX)).length,
      untouchedStarterIds: new Set(
        storedStarters.filter(isUntouchedStarter).map((recipe) => recipe.id)
      ),
      existingCollections,
      existingMealPlan,
      now: options.now?.() ?? new Date().toISOString(),
      createId: options.createId ?? defaultCreateId
    });

    const total = plan.recipes.length + plan.membershipAdditions.length;
    let completed = 0;
    options.onProgress?.({ done: 0, total });

    for (const collection of plan.collections) {
      await collectionsStore.put(collection);
    }

    for (const recipe of plan.recipes) {
      const record = toSavedRecipeListRecord(recipe);
      await recipesStore.put(record);

      if (recipe.sourceImages?.length) {
        const images: WebRecipeSourceImagesRecord = {
          images: recipe.sourceImages,
          recipeId: recipe.id,
          updatedAt: recipe.updatedAt
        };
        await imagesStore.put(images);
      }

      written.push(record);
      completed += 1;
      options.onProgress?.({ done: completed, total });
    }

    for (const addition of plan.membershipAdditions) {
      const existing = (await recipesStore.get(addition.recipeId)) as WebSavedRecipe | undefined;
      const current = existing?.collectionIds ?? [];
      const missing = addition.collectionIds.filter((id) => !current.includes(id));

      if (existing && missing.length) {
        const next: WebSavedRecipe = { ...existing, collectionIds: [...current, ...missing] };
        await recipesStore.put(next);
        membershipUpdates.push(toSavedRecipeListRecord(next));
      }

      completed += 1;
      options.onProgress?.({ done: completed, total });
    }

    for (const entry of plan.mealPlan) {
      await mealPlanStore.put(entry);
    }

    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // Already aborted by the failing request.
    }

    if (isStorageFullError(error)) {
      throw new DataTransferError("storage_full");
    }

    throw error instanceof DataTransferError ? error : new DataTransferError("write_failed");
  }

  if (plan.collections.length) {
    emitDataChange({ topic: "collections", upserted: plan.collections });
  }

  if (written.length || membershipUpdates.length) {
    emitDataChange({ topic: "savedRecipes", upserted: [...written, ...membershipUpdates] });
  }

  if (plan.mealPlan.length) {
    emitDataChange({ topic: "mealPlan", upserted: plan.mealPlan });
  }

  return { plan, recipeIds: written.map((recipe) => recipe.id) };
}
