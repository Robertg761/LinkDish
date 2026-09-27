import { describe, expect, it } from "vitest";

import {
  MAX_RECIPE_DESCRIPTION_LENGTH,
  MAX_RECIPE_KEYWORD_COUNT,
  MAX_RECIPE_KEYWORD_LENGTH,
  recipeObjectSchema,
  recipeSchema,
  SAMPLE_RECIPES
} from "./index.js";

const legacyRecipe = {
  title: "Lemon Pasta",
  sourceUrl: "https://example.com/lemon-pasta",
  sourceType: "recipe-webpage",
  ingredients: [{ text: "200g pasta" }],
  steps: [{ index: 1, text: "Boil the pasta." }],
  servings: "2 servings",
  prepTimeMinutes: 10,
  cookTimeMinutes: 15,
  nutrition: null,
  confidence: {
    score: 0.94,
    summary: "Structured recipe data was present.",
    missingFields: [],
    notes: [],
    fieldProvenance: {
      title: "jsonld",
      ingredients: "jsonld",
      steps: "jsonld",
      servings: "jsonld",
      prepTimeMinutes: "jsonld",
      cookTimeMinutes: "jsonld",
      nutrition: null
    }
  }
};

const metadataKeys = [
  "description",
  "totalTimeMinutes",
  "author",
  "siteName",
  "cuisine",
  "category",
  "keywords",
  "videoUrl"
] as const;

describe("recipe metadata fields", () => {
  it("parses records saved before the metadata existed without adding keys", () => {
    const parsed = recipeSchema.parse(legacyRecipe);

    for (const key of metadataKeys) {
      expect(parsed, key).not.toHaveProperty(key);
    }
  });

  it("keeps every starter recipe valid", () => {
    for (const sample of SAMPLE_RECIPES) {
      expect(recipeSchema.safeParse(sample.recipe).success).toBe(true);
    }
  });

  it("accepts the full metadata set", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      description: "Bright, fast, weeknight pasta.",
      totalTimeMinutes: 25,
      author: "Ada Cook",
      siteName: "Example Kitchen",
      cuisine: "Italian",
      category: "Dinner",
      keywords: ["pasta", "lemon", "quick"],
      videoUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(parsed).toMatchObject({
      description: "Bright, fast, weeknight pasta.",
      totalTimeMinutes: 25,
      author: "Ada Cook",
      siteName: "Example Kitchen",
      cuisine: "Italian",
      category: "Dinner",
      keywords: ["pasta", "lemon", "quick"],
      videoUrl: "https://www.youtube.com/watch?v=abc123"
    });
  });

  it("accepts explicit nulls", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      description: null,
      totalTimeMinutes: null,
      author: null,
      siteName: null,
      cuisine: null,
      category: null,
      keywords: null,
      videoUrl: null
    });

    expect(parsed.description).toBeNull();
    expect(parsed.keywords).toBeNull();
  });

  it("turns blank text into null and collapses whitespace in short fields", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      description: "   ",
      author: "  Ada \n  Cook ",
      videoUrl: "  "
    });

    expect(parsed.description).toBeNull();
    expect(parsed.author).toBe("Ada Cook");
    expect(parsed.videoUrl).toBeNull();
  });

  it("keeps paragraph breaks in the description", () => {
    const parsed = recipeSchema.parse({ ...legacyRecipe, description: "One.\n\nTwo." });

    expect(parsed.description).toBe("One.\n\nTwo.");
  });

  it("clips oversized third-party text instead of failing the import", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      description: "d".repeat(MAX_RECIPE_DESCRIPTION_LENGTH + 500),
      author: "a".repeat(1_000)
    });

    expect(parsed.description).toHaveLength(MAX_RECIPE_DESCRIPTION_LENGTH);
    expect(parsed.author).toHaveLength(200);
  });

  it("never leaves half a surrogate pair when clipping", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      author: `${"a".repeat(199)}😀`
    });

    expect(parsed.author).toBe("a".repeat(199));
  });

  it("normalizes schema.org keyword strings and arrays", () => {
    expect(
      recipeSchema.parse({ ...legacyRecipe, keywords: "pasta, Lemon,lemon , ,quick" }).keywords
    ).toEqual(["pasta", "Lemon", "quick"]);
    expect(
      recipeSchema.parse({ ...legacyRecipe, keywords: ["pasta", 3, "", "Pasta"] }).keywords
    ).toEqual(["pasta"]);
  });

  it("bounds keyword count and length", () => {
    const parsed = recipeSchema.parse({
      ...legacyRecipe,
      keywords: Array.from({ length: 80 }, (_unused, index) => `keyword ${index} ${"x".repeat(80)}`)
    });

    expect(parsed.keywords).toHaveLength(MAX_RECIPE_KEYWORD_COUNT);
    for (const keyword of parsed.keywords ?? []) {
      expect(keyword.length).toBeLessThanOrEqual(MAX_RECIPE_KEYWORD_LENGTH);
    }
  });

  it("rejects dangerous video urls like every other recipe url", () => {
    for (const videoUrl of ["javascript:alert(1)", "data:text/html,x", "http://u:p@evil.com/"]) {
      expect(recipeSchema.safeParse({ ...legacyRecipe, videoUrl }).success, videoUrl).toBe(false);
    }
  });

  it("rejects negative, fractional and absurd total times", () => {
    for (const totalTimeMinutes of [-1, 2.5, 10_000_000]) {
      expect(recipeSchema.safeParse({ ...legacyRecipe, totalTimeMinutes }).success).toBe(false);
    }
  });

  it("exposes the underlying object schema", () => {
    expect(recipeObjectSchema).toBe(recipeSchema);
    expect(Object.keys(recipeObjectSchema.shape)).toEqual(
      expect.arrayContaining(["title", "ingredients", ...metadataKeys])
    );
    expect(recipeObjectSchema.pick({ title: true }).parse({ title: "Soup" })).toEqual({
      title: "Soup"
    });
  });
});
