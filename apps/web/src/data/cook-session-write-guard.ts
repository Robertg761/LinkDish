/**
 * Per recipe, bumped when the recipe is deleted (with its cook session): a cook-session write this
 * tab made for it before then, still queued or waiting to be queued, is dropped when it comes up
 * instead of creating the deleted session again. Writes made after it (a restored recipe's) go
 * through as usual.
 */
const generations = new Map<string, number>();

/** Where this tab's cook-session writes for `recipeId` stand now. */
export const getCookSessionWriteGeneration = (recipeId: string): number =>
  generations.get(recipeId) ?? 0;

/** Drops every cook-session write for `recipeId` made before now that hasn't landed yet. */
export const discardCookSessionWrites = (recipeId: string): void => {
  generations.set(recipeId, getCookSessionWriteGeneration(recipeId) + 1);
};
