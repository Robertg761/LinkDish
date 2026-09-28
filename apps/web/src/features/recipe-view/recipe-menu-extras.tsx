import type { MenuEntry } from "../../components/Menu";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type React from "react";

/**
 * Extension point for the recipe overflow menu. Features that own their own sheets (collections,
 * tags, meal plan…) add menu entries here and render their sheets through `elements`; the recipe
 * page places the entries between "Print" and "Delete" and mounts the elements once.
 */
export interface RecipeMenuExtras {
  items: readonly MenuEntry[];
  elements: React.ReactNode;
}

const NO_EXTRAS: RecipeMenuExtras = { elements: null, items: [] };

/**
 * `recipe` is the saved recipe on screen (null on household-shared routes, where personal
 * organisation does not apply).
 */
export const useRecipeMenuExtras = (recipe: WebSavedRecipe | null): RecipeMenuExtras => {
  void recipe;
  return NO_EXTRAS;
};
