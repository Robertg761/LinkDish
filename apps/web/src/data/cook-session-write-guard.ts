/**
 * Keeps this tab's cook-session writes from creating the session of a recipe deleted after the
 * change was made. Per recipe, a generation is bumped once a deletion has gone through (this
 * tab's, or another tab's as it reports it): a write made before then is dropped when it comes
 * up, and writes made after it (a restored recipe's) go through as usual. While this tab's
 * deletion is under way, writes wait for it: dropped if it goes through, made if it fails.
 */
const generations = new Map<string, number>();
const pendingDeletions = new Map<string, Promise<boolean>>();

/** Where this tab's cook-session writes for `recipeId` stand now. */
export const getCookSessionWriteGeneration = (recipeId: string): number =>
  generations.get(recipeId) ?? 0;

const bump = (recipeId: string) => {
  generations.set(recipeId, getCookSessionWriteGeneration(recipeId) + 1);
};

/** Another tab deleted `recipeId`: drops every write for it this tab made before now. */
export const discardCookSessionWrites = (recipeId: string): void => {
  bump(recipeId);
};

/**
 * Tracks this tab's deletion of `recipeId` (with its cook session). Call it before the deletion
 * starts writing. Returns `deletion`.
 */
export const trackRecipeDeletion = <Result>(
  recipeId: string,
  deletion: Promise<Result>
): Promise<Result> => {
  const settled = deletion.then(
    () => {
      bump(recipeId);
      return true;
    },
    () => false
  );
  pendingDeletions.set(recipeId, settled);
  void settled.then(() => {
    if (pendingDeletions.get(recipeId) === settled) {
      pendingDeletions.delete(recipeId);
    }
  });
  return deletion;
};

/** This tab's deletion of `recipeId` under way, if any: true once it went through. */
export const getPendingRecipeDeletion = (recipeId: string): Promise<boolean> | undefined =>
  pendingDeletions.get(recipeId);
