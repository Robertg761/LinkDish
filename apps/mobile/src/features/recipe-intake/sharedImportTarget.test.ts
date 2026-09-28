import { describe, expect, it } from "vitest";

import { getSharedImportTarget } from "./sharedImportTarget";

describe("getSharedImportTarget", () => {
  const findSavedRecipeId = (url: string) =>
    url.startsWith("https://site.com/saved") ? "saved-1" : undefined;

  it("opens an already saved recipe instead of spending an import", () => {
    expect(
      getSharedImportTarget({
        findSavedRecipeId,
        hasLoadedSavedRecipes: true,
        sharedUrl: "https://site.com/saved?utm_source=instagram"
      })
    ).toEqual({ kind: "saved", savedId: "saved-1" });
  });

  it("imports links that are not in the Cookbook yet", () => {
    expect(
      getSharedImportTarget({
        findSavedRecipeId,
        hasLoadedSavedRecipes: true,
        sharedUrl: "https://site.com/new"
      })
    ).toEqual({ kind: "extract", url: "https://site.com/new" });
  });

  it("waits for the Cookbook to load and ignores shares without a link", () => {
    expect(
      getSharedImportTarget({
        findSavedRecipeId,
        hasLoadedSavedRecipes: false,
        sharedUrl: "https://site.com/new"
      })
    ).toEqual({ kind: "wait" });
    expect(
      getSharedImportTarget({
        findSavedRecipeId,
        hasLoadedSavedRecipes: true,
        sharedUrl: undefined
      })
    ).toEqual({ kind: "none" });
  });
});
