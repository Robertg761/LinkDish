import { describe, expect, it } from "vitest";

import { recipeSchema } from "../../../../../../packages/recipe-domain/src/index.js";

import { normalizeExtractionCandidate } from "./index";

import type { ExtractionCandidate } from "../types";

const baseCandidate = (recipe: ExtractionCandidate["recipe"]): ExtractionCandidate => ({
  recipe,
  strategy: "recipe-schema",
  evidence: ["Detected Recipe JSON-LD on the page."],
  warnings: [],
  provenance: ["jsonld"],
  fieldProvenance: {
    title: "jsonld",
    ingredients: "jsonld",
    steps: "jsonld",
    servings: null,
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    nutrition: null
  },
  signals: {
    requiredFieldsInferred: false,
    titleConfidence: "strong",
    timesFromStructuredMetadata: false,
    recipeLike: true,
    detectionConfidence: "high",
    sectionCohesion: "strong",
    transcriptQuality: "weak",
    usedBrowserFallback: false,
    blockedSourceSignals: 0
  }
});

const coreRecipe = {
  title: "Soup",
  ingredients: [{ text: "1 onion" }, { text: "2 cups stock" }],
  steps: [{ index: 1, text: "Simmer." }],
  servings: "4",
  prepTimeMinutes: 5,
  cookTimeMinutes: 20,
  nutrition: null
};

const normalize = (recipe: ExtractionCandidate["recipe"]) =>
  normalizeExtractionCandidate(
    baseCandidate(recipe),
    "recipe-webpage",
    "https://example.com/soup",
    "http"
  );

describe("normalizeExtractionCandidate metadata", () => {
  it("passes optional metadata through, decoded", () => {
    const normalized = normalize({
      ...coreRecipe,
      description: "Cosy &amp; quick.",
      totalTimeMinutes: 25,
      author: "Ada&nbsp;Cook",
      siteName: "Fixture Kitchen",
      cuisine: "French",
      category: "Soup",
      keywords: ["soup", "", "easy"],
      videoUrl: "https://www.youtube.com/watch?v=abc123def45"
    });

    expect(normalized?.recipe).toMatchObject({
      description: "Cosy & quick.",
      totalTimeMinutes: 25,
      author: "Ada Cook",
      siteName: "Fixture Kitchen",
      cuisine: "French",
      category: "Soup",
      keywords: ["soup", "easy"],
      videoUrl: "https://www.youtube.com/watch?v=abc123def45"
    });
    expect(normalized?.warnings).toEqual([]);
  });

  it("leaves metadata keys off recipes that have none", () => {
    const normalized = normalize(coreRecipe);

    for (const key of ["description", "totalTimeMinutes", "author", "keywords", "videoUrl"]) {
      expect(normalized?.recipe).not.toHaveProperty(key);
    }
  });

  it("notes missing servings and times as a plain-language warning", () => {
    const warningsFor = (recipe: Partial<ExtractionCandidate["recipe"]>) =>
      normalize({
        ...coreRecipe,
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        ...recipe
      })?.warnings;

    expect(warningsFor({})).toEqual(["The source didn't list servings or cooking times."]);
    expect(warningsFor({ servings: "4", totalTimeMinutes: 30 })).toEqual([]);
    expect(warningsFor({ servings: "4", prepTimeMinutes: 10 })).toEqual([
      "The source didn't list a cook time."
    ]);
    expect(warningsFor({ prepTimeMinutes: 10, cookTimeMinutes: 5 })).toEqual([
      "The source didn't list servings."
    ]);
  });
});

describe("normalizeExtractionCandidate limits", () => {
  it("clips oversized fields to the response contract instead of failing", () => {
    const normalized = normalize({
      ...coreRecipe,
      title: "T".repeat(400),
      ingredients: Array.from({ length: 320 }, (_, index) => ({
        text: `${index + 1} ${"x".repeat(2_100)}`
      })),
      steps: [{ index: 1, text: "S".repeat(10_500) }],
      servings: "4".repeat(250),
      nutrition: {
        calories: "9".repeat(300),
        protein: null,
        carbohydrates: null,
        fat: null,
        fiber: null,
        sugar: null,
        sodium: null
      }
    });

    expect(normalized?.recipe.title).toHaveLength(300);
    expect(normalized?.recipe.ingredients).toHaveLength(300);
    expect(normalized?.recipe.ingredients[0]?.text.length).toBeLessThanOrEqual(2_000);
    expect(normalized?.recipe.steps[0]?.text).toHaveLength(10_000);
    expect(normalized?.recipe.servings).toHaveLength(200);
    expect(normalized?.recipe.nutrition?.calories).toHaveLength(200);
    expect(recipeSchema.safeParse(normalized?.recipe).success).toBe(true);
  });
});
