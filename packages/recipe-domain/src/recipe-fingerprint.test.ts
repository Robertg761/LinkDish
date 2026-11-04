import { describe, expect, it } from "vitest";

import { recipeContentFingerprint } from "./recipe-fingerprint.js";

describe("recipeContentFingerprint", () => {
  it("ignores key order at any depth, and blank notes", () => {
    const left = { recipe: { title: "Soup", nutrition: { fat: 1, salt: 2 } } };
    const right = { notes: "  ", recipe: { nutrition: { salt: 2, fat: 1 }, title: "Soup" } };

    expect(recipeContentFingerprint(left)).toBe(recipeContentFingerprint(right));
  });

  it("changes with the recipe, its notes and the order of its steps", () => {
    const base = { recipe: { steps: ["a", "b"], title: "Soup" } };

    expect(recipeContentFingerprint(base)).not.toBe(
      recipeContentFingerprint({ recipe: { ...base.recipe, title: "Stew" } })
    );
    expect(recipeContentFingerprint(base)).not.toBe(
      recipeContentFingerprint({ ...base, notes: "Less salt" })
    );
    expect(recipeContentFingerprint(base)).not.toBe(
      recipeContentFingerprint({ recipe: { ...base.recipe, steps: ["b", "a"] } })
    );
  });
});
