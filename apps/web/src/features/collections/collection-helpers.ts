import { CollectionValidationError } from "../../data/collections-store";

import type { WebCollection } from "../../data/collections-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

/** Quick picks for a collection's emoji (any emoji can still be typed). */
export const COLLECTION_EMOJI_CHOICES = [
  "🍝",
  "🥗",
  "🍲",
  "🌮",
  "🍜",
  "🥘",
  "🍰",
  "🍪",
  "🥞",
  "🍞",
  "🔥",
  "🌱",
  "🎄",
  "⭐"
] as const;

/** "🍝 Pasta night", or just the name when there is no emoji. */
export const formatCollectionLabel = (collection: Pick<WebCollection, "name" | "emoji">): string =>
  collection.emoji ? `${collection.emoji} ${collection.name}` : collection.name;

/** How many of the given recipes are in each collection. */
export const countRecipesByCollection = (
  recipes: readonly WebSavedRecipe[]
): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const recipe of recipes) {
    for (const id of recipe.collectionIds ?? []) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return counts;
};

export type MembershipState = "all" | "some" | "none";

/** Whether all, some or none of `recipeIds` belong to `collectionId`. */
export const getMembershipState = (
  recipes: ReadonlyMap<string, WebSavedRecipe>,
  recipeIds: readonly string[],
  collectionId: string
): MembershipState => {
  let members = 0;

  for (const id of recipeIds) {
    if (recipes.get(id)?.collectionIds?.includes(collectionId)) {
      members += 1;
    }
  }

  return members === 0 ? "none" : members === recipeIds.length ? "all" : "some";
};

export const formatRecipeCount = (count: number): string =>
  count === 1 ? "1 recipe" : `${count} recipes`;

/** Plain-language copy for a failed collection write. */
export const getCollectionErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof CollectionValidationError ? error.message : fallback;
