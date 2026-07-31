import { describe, expect, it } from "vitest";

import { buildRecipeMetaLine } from "./recipe-meta";

describe("buildRecipeMetaLine", () => {
  const baseRecipe = {
    cookTimeMinutes: 38,
    prepTimeMinutes: 10,
    sourceType: "recipe-webpage"
  } as const;

  it("includes source type by default for recipe detail metadata", () => {
    expect(buildRecipeMetaLine({ ...baseRecipe, servings: "4" })).toBe(
      "Webpage · 4 servings · Prep 10 min · Cook 38 min"
    );
  });

  it.each([
    ["9 bars", "9 bars · Prep 10 min · Cook 38 min"],
    ["4", "4 servings · Prep 10 min · Cook 38 min"],
    ["4 pita halves", "4 pita halves · Prep 10 min · Cook 38 min"]
  ])("formats list-row yield %s without duplicating units", (servings, expected) => {
    expect(
      buildRecipeMetaLine(
        { ...baseRecipe, servings },
        { includeSourceType: false, servingsFallback: null }
      )
    ).toBe(expected);
  });

  it("omits empty list-row parts", () => {
    expect(
      buildRecipeMetaLine(
        {
          cookTimeMinutes: 0,
          prepTimeMinutes: null,
          servings: null,
          sourceType: "recipe-webpage"
        },
        { includeSourceType: false, servingsFallback: null }
      )
    ).toBe("");
  });
});
