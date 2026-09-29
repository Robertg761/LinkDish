import { describe, expect, it } from "vitest";

import { findRecipeTextArtifact, recipeNeedsTextCleanup } from "./needs-text-cleanup";

import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

const cleanRecipe: Recipe = {
  title: "One-Pan Tomato Pasta",
  sourceUrl: "https://example.com/pasta",
  sourceType: "recipe-webpage",
  image: null,
  ingredients: [
    { text: "12 oz spaghetti", section: null },
    { text: "2 cups cherry tomatoes (halved)", section: "Sauce" },
    { text: "1 tbsp olive oil, plus more to serve", section: "Sauce" }
  ],
  steps: [
    { index: 1, text: "Boil the pasta in salted water until al dente, about 9 minutes." },
    { index: 2, text: "Cook the tomatoes in the oil; season with salt & pepper." }
  ],
  servings: "4 servings",
  prepTimeMinutes: 10,
  cookTimeMinutes: 20,
  nutrition: {
    calories: "480 kcal",
    protein: "18 g",
    carbohydrates: null,
    fat: null,
    fiber: null,
    sugar: null,
    sodium: "420 mg"
  },
  confidence: {
    score: 0.92,
    summary: "Structured recipe evidence was detected.",
    missingFields: [],
    notes: [],
    fieldProvenance: {
      title: "jsonld",
      ingredients: "jsonld",
      steps: "jsonld",
      servings: "jsonld",
      prepTimeMinutes: "jsonld",
      cookTimeMinutes: "jsonld",
      nutrition: "jsonld"
    }
  }
};

const withStep = (text: string): Recipe => ({
  ...cleanRecipe,
  steps: [{ index: 1, text }]
});

describe("recipeNeedsTextCleanup", () => {
  it("leaves clean structured recipes alone", () => {
    expect(findRecipeTextArtifact(cleanRecipe)).toBeNull();
    expect(recipeNeedsTextCleanup(cleanRecipe)).toBe(false);
  });

  it.each([
    ["HTML tags", "<p>Boil the pasta.</p>"],
    ["leftover entities", "Salt &amp; pepper to taste."],
    ["navigation labels", "Boil the pasta. Jump to Recipe"],
    ["ad fragments", "Boil the pasta. Advertisement"],
    ["repeated whitespace", "Boil  the pasta."],
    ["line breaks", "Boil the pasta.\nDrain it."],
    ["broken punctuation", "Boil the pasta , then drain."],
    ["encoding artifacts", "Cook the crÃ¨me fraÃ®che gently."],
    ["a doubled line", "Drain the pasta well. Drain the pasta well."],
    ["all caps", "BOIL THE PASTA UNTIL TENDER."]
  ])("flags %s in step text", (_label, text) => {
    expect(findRecipeTextArtifact(withStep(text))).toBe("step_text");
  });

  it("flags artifacts in titles, ingredients, sections, servings and nutrition", () => {
    expect(findRecipeTextArtifact({ ...cleanRecipe, title: "PASTA &nbsp; NIGHT" })).toBe("title");
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [{ text: "12 oz <b>spaghetti</b>", section: null }]
      })
    ).toBe("ingredient_text");
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [{ text: "12 oz spaghetti", section: "Print Recipe" }]
      })
    ).toBe("section_text");
    expect(findRecipeTextArtifact({ ...cleanRecipe, servings: " 4 servings" })).toBe(
      "servings_text"
    );
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        nutrition: { ...cleanRecipe.nutrition!, calories: "480&nbsp;kcal" }
      })
    ).toBe("nutrition_text");
  });

  it("flags duplicated ingredient or step lines", () => {
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [
          { text: "12 oz spaghetti", section: null },
          { text: "12 OZ Spaghetti ", section: null }
        ]
      })
    ).toBe("ingredient_text");
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [
          { text: "12 oz spaghetti", section: null },
          { text: "12 oz  spaghetti", section: "Pasta" }
        ]
      })
    ).toBe("ingredient_text");
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [
          { text: "1 tsp vanilla extract", section: "Cake" },
          { text: "1 tsp vanilla extract", section: "Frosting" }
        ]
      })
    ).toBeNull();
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        ingredients: [
          { text: "12 oz spaghetti", section: "Pasta" },
          { text: "12 oz Spaghetti", section: "Pasta" }
        ]
      })
    ).toBe("duplicate_ingredients");
    expect(
      findRecipeTextArtifact({
        ...cleanRecipe,
        steps: [
          { index: 1, text: "Boil the pasta." },
          { index: 2, text: "boil the pasta." }
        ]
      })
    ).toBe("duplicate_steps");
  });

  it("does not treat short uppercase units or ordinary comparisons as artifacts", () => {
    expect(
      recipeNeedsTextCleanup({
        ...cleanRecipe,
        ingredients: [{ text: "2 TBSP olive oil", section: null }],
        steps: [{ index: 1, text: "Roast until the chicken is > 165F inside, about 40 min." }]
      })
    ).toBe(false);
  });
});
