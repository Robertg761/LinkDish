import { createRecipeSearchIndex, recipeSearchFields } from "@linkdish/recipe-domain";

import { getRecipeSearchIndex, recipeSearchKey } from "./use-library-search";

import type { RecipeSearchIndexOptions, SearchIndexBuilder } from "./use-library-search";
import type { WebSavedRecipe } from "../saved-recipe-types";
import type { RecipeSearchIndex } from "@linkdish/recipe-domain";

/*
 * The saved-recipe index the command palette and the plan picker search with. It is built on the
 * first non-empty query (opening either with no query costs nothing) and kept at module scope,
 * keyed by the recipes' text, so reopening them — or a favorite in between — never re-indexes an
 * unchanged cookbook.
 */

const BUILDER: SearchIndexBuilder = { createRecipeSearchIndex, recipeSearchFields };

const OPTIONS: RecipeSearchIndexOptions<WebSavedRecipe> = {
  cacheKey: "saved-recipes",
  getFields: (engine, recipe) =>
    engine.recipeSearchFields(recipe.recipe, { notes: recipe.notes, tags: recipe.tags }),
  getId: (recipe) => recipe.id,
  getSignature: (recipe) => [
    recipeSearchKey(recipe.recipe),
    recipe.notes,
    recipe.tags?.join("\u0001")
  ]
};

export interface SavedRecipeMatch {
  recipe: WebSavedRecipe;
  titleMatch: boolean;
}

/** Search over saved recipes; the index is built (or reused) only when a query runs. */
export const createSavedRecipeSearch = (
  recipes: readonly WebSavedRecipe[]
): ((query: string, limit: number) => SavedRecipeMatch[]) => {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  let index: RecipeSearchIndex<string> | null = null;

  return (query, limit) => {
    index ??= getRecipeSearchIndex(BUILDER, recipes, byId, OPTIONS);

    return index.search(query, { limit }).flatMap((result) => {
      const recipe = byId.get(result.record);
      return recipe ? [{ recipe, titleMatch: result.matches.includes("title") }] : [];
    });
  };
};
