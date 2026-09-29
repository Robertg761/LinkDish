import { getLinkDishWebDb } from "../../../storage/linkdish-db";
import { fakeIdb } from "../../../storage/testing/fake-idb";

import type { MealPlanEntry } from "../../../data/meal-plan-store";
import type { WebSavedRecipe } from "../../library/saved-recipe-types";

/** Test-only fixtures for the planner (imported by *.test.tsx files only). */

export const makeSavedRecipe = (
  id: string,
  title: string,
  overrides: Partial<WebSavedRecipe> & { ingredients?: string[]; servings?: string } = {}
): WebSavedRecipe => {
  const { ingredients, servings, ...rest } = overrides;

  return {
    createdAt: "2026-09-01T10:00:00.000Z",
    extraction: { fetchMode: "http", provenance: [], strategy: "json-ld", warnings: [] },
    id,
    recipe: {
      cookTimeMinutes: 20,
      image: null,
      ingredients: (ingredients ?? ["1 lb pasta", "2 cups tomato sauce", "salt to taste"]).map(
        (text) => ({ text })
      ),
      nutrition: null,
      prepTimeMinutes: 10,
      servings: servings ?? "4 servings",
      sourceType: "recipe-webpage",
      sourceUrl: `https://example.com/${id}`,
      steps: [{ index: 1, text: "Cook." }],
      title
    },
    sourceHost: "example.com",
    sourceUrl: `https://example.com/${id}`,
    sync: { status: "local_only" },
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...rest
  } as unknown as WebSavedRecipe;
};

export const makePlanEntry = (
  overrides: Partial<MealPlanEntry> & { date: string }
): MealPlanEntry => ({
  createdAt: "2026-09-20T10:00:00.000Z",
  id: `entry-${overrides.date}-${overrides.title ?? "x"}`,
  slot: "dinner",
  title: "Pasta",
  updatedAt: "2026-09-20T10:00:00.000Z",
  ...overrides
});

/** Opens the (fake) database so stores exist, then seeds records. */
export async function seedPlannerData(data: {
  recipes?: WebSavedRecipe[];
  entries?: MealPlanEntry[];
}): Promise<void> {
  await getLinkDishWebDb();

  if (data.recipes?.length) {
    fakeIdb.seed("savedRecipes", data.recipes);
  }

  if (data.entries?.length) {
    fakeIdb.seed("mealPlan", data.entries);
  }
}
