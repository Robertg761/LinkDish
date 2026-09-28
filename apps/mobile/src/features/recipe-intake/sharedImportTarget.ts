export type SharedImportTarget =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "saved"; savedId: string }
  | { kind: "extract"; url: string };

/**
 * What the share-sheet import should do with a shared link. The Cookbook is checked first
 * (getSavedRecipeBySourceUrl matches tracked and reformatted links to the same page), so
 * sharing a recipe that is already saved opens it instead of spending an import. Until the
 * Cookbook has loaded from storage the import waits rather than guessing.
 */
export const getSharedImportTarget = (input: {
  findSavedRecipeId: (url: string) => string | undefined;
  hasLoadedSavedRecipes: boolean;
  sharedUrl: string | undefined;
}): SharedImportTarget => {
  if (!input.sharedUrl) {
    return { kind: "none" };
  }

  if (!input.hasLoadedSavedRecipes) {
    return { kind: "wait" };
  }

  const savedId = input.findSavedRecipeId(input.sharedUrl);

  return savedId ? { kind: "saved", savedId } : { kind: "extract", url: input.sharedUrl };
};
