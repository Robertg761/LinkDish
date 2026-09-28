/**
 * Which recipes a backup carries. Dependency-free so the Settings page can show counts without
 * loading the export code.
 */
import type { WebSavedRecipe } from "../library/saved-recipe-types";

/**
 * Whether a recipe carries anything personal: favorite, tags, collections, rating, notes, cooking
 * history, preferred servings, or edits.
 */
export const isPersonalizedRecipe = (recipe: WebSavedRecipe): boolean =>
  Boolean(
    recipe.favorite ||
    recipe.tags?.length ||
    recipe.collectionIds?.length ||
    recipe.rating ||
    recipe.notes?.trim() ||
    recipe.cookLog?.length ||
    (recipe.timesCooked ?? 0) > 0 ||
    recipe.preferredServings ||
    recipe.updatedAt !== recipe.createdAt
  );

/**
 * Personal recipes, plus starter recipes someone made their own. An untouched starter is
 * re-created on every new device anyway, so backing it up would only add noise.
 */
export const selectExportRecipes = (recipes: readonly WebSavedRecipe[]): WebSavedRecipe[] =>
  recipes.filter((recipe) => !recipe.isStarter || isPersonalizedRecipe(recipe));
