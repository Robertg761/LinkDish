import { describe, expect, it } from "vitest";

import { buildRecipeMetaLine, formatRecipeServings } from "./recipeMetaLine";

const base = {
  cookTimeMinutes: null,
  prepTimeMinutes: null,
  servings: null,
  sourceType: "article" as const
};

describe("buildRecipeMetaLine", () => {
  it("cleans up raw servings text", () => {
    expect(formatRecipeServings("16, 1 loaf")).toBe("Serves 16 · 1 loaf");
    expect(formatRecipeServings("4&nbsp;servings")).toBe("Serves 4");
    expect(formatRecipeServings("Makes 12 cookies")).toBe("12 cookies");
    expect(formatRecipeServings("Varies")).toBe("Varies");
    expect(formatRecipeServings("  ")).toBeNull();
  });

  it("prints long times in hours instead of 'Cook 180 min'", () => {
    const line = buildRecipeMetaLine({ ...base, cookTimeMinutes: 180, servings: "16, 1 loaf" });

    expect(line).toBe("Webpage · Serves 16 · 1 loaf · Cook 3 hr");
    expect(line).not.toContain("180 min");
  });

  it("adds a total only when it tells the cook something new", () => {
    expect(
      buildRecipeMetaLine(
        { ...base, cookTimeMinutes: 20, prepTimeMinutes: 10 },
        { includeSourceType: false }
      )
    ).toBe("Prep 10 min · Cook 20 min · Total 30 min");
    expect(
      buildRecipeMetaLine(
        { ...base, prepTimeMinutes: 20, totalTimeMinutes: 260 },
        { includeSourceType: false }
      )
    ).toBe("Prep 20 min · Total 4 hr 20 min");
    expect(
      buildRecipeMetaLine(
        { ...base, cookTimeMinutes: 45, totalTimeMinutes: 45 },
        { includeSourceType: false }
      )
    ).toBe("Cook 45 min");
  });

  it("keeps Cookbook rows compact", () => {
    expect(
      buildRecipeMetaLine(
        { ...base, cookTimeMinutes: 20, prepTimeMinutes: 10, servings: "4 servings" },
        { compact: true }
      )
    ).toBe("Serves 4 · 30 min");
    expect(buildRecipeMetaLine(base, { compact: true })).toBe("");
  });
});
