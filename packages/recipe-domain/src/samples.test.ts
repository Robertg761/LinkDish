import { describe, expect, it } from "vitest";

import { recipeSchema, SAMPLE_RECIPES } from "./index";

describe("SAMPLE_RECIPES", () => {
  it("validates every starter recipe against the recipe schema", () => {
    expect(SAMPLE_RECIPES).toHaveLength(3);

    for (const sample of SAMPLE_RECIPES) {
      expect(sample.kind).toBe("starter-recipe");
      expect(sample.label).toBe("starter recipe");
      expect(sample.countsTowardQuota).toBe(false);
      expect(() => recipeSchema.parse(sample.recipe)).not.toThrow();
    }
  });

  it("uses stable unique starter ids", () => {
    const ids = SAMPLE_RECIPES.map((sample) => sample.id);

    expect(ids).toEqual([
      "starter-ginger-sesame-chicken-rice-skillet",
      "starter-brown-butter-berry-oat-bars",
      "starter-crisp-cucumber-chickpea-pitas"
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps timer-friendly durations in the baked good steps", () => {
    const bakedGood = SAMPLE_RECIPES.find((sample) => sample.id === "starter-brown-butter-berry-oat-bars");

    expect(bakedGood).toBeDefined();
    expect(bakedGood?.recipe.steps.map((step) => step.text).join(" ")).toMatch(/\b(?:4-6|8|25-30|30) minutes\b/);
  });
});
