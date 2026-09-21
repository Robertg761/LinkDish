import { describe, expect, it } from "vitest";

import { httpUrlSchema, recipeSchema } from "./index.js";

const baseRecipe = {
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

const dangerousUrls = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
  "http://user:pass@evil.com@good.com/"
];

describe("httpUrlSchema", () => {
  it("rejects non-http(s) and credential-bearing urls", () => {
    for (const url of dangerousUrls) {
      expect(httpUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it("accepts ordinary http and https urls", () => {
    for (const url of [
      "https://example.com/recipes/lemon-pasta",
      "http://example.com/recipes/lemon-pasta",
      "https://cdn.example.com/img.jpg?v=2#top"
    ]) {
      expect(httpUrlSchema.safeParse(url).success).toBe(true);
    }
  });

  it("rejects absurdly long urls", () => {
    expect(httpUrlSchema.safeParse(`https://example.com/${"a".repeat(4000)}`).success).toBe(false);
  });
});

describe("recipeSchema url hardening", () => {
  it("rejects dangerous recipe source urls", () => {
    for (const url of dangerousUrls) {
      expect(recipeSchema.safeParse({ ...baseRecipe, sourceUrl: url }).success).toBe(false);
    }
  });

  it("rejects dangerous recipe image urls", () => {
    for (const url of dangerousUrls) {
      expect(
        recipeSchema.safeParse({
          ...baseRecipe,
          image: { url, source: "og" }
        }).success
      ).toBe(false);
    }
  });
});

describe("recipeSchema bounds", () => {
  it("rejects an unbounded title", () => {
    expect(recipeSchema.safeParse({ ...baseRecipe, title: "x".repeat(5_000) }).success).toBe(false);
  });

  it("rejects a recipe with no ingredients", () => {
    expect(recipeSchema.safeParse({ ...baseRecipe, ingredients: [] }).success).toBe(false);
  });

  it("rejects a recipe with no steps", () => {
    expect(recipeSchema.safeParse({ ...baseRecipe, steps: [] }).success).toBe(false);
  });

  it("rejects absurd ingredient and step counts", () => {
    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        ingredients: Array.from({ length: 5_000 }, () => ({ text: "salt" }))
      }).success
    ).toBe(false);

    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        steps: Array.from({ length: 5_000 }, (_unused, index) => ({
          index: index + 1,
          text: "Stir."
        }))
      }).success
    ).toBe(false);
  });

  it("rejects unbounded ingredient and step text", () => {
    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        ingredients: [{ text: "x".repeat(50_000) }]
      }).success
    ).toBe(false);

    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        steps: [{ index: 1, text: "x".repeat(200_000) }]
      }).success
    ).toBe(false);
  });

  it("rejects duplicate step indices", () => {
    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        steps: [
          { index: 1, text: "Boil the pasta." },
          { index: 1, text: "Drain the pasta." }
        ]
      }).success
    ).toBe(false);
  });

  it("accepts ordered unique step indices that are not contiguous", () => {
    const parsed = recipeSchema.safeParse({
      ...baseRecipe,
      steps: [
        { index: 1, text: "Boil the pasta." },
        { index: 3, text: "Serve." }
      ]
    });

    expect(parsed.success).toBe(true);
  });

  it("treats a blank servings string as missing instead of storing it", () => {
    const parsed = recipeSchema.parse({ ...baseRecipe, servings: "   " });

    expect(parsed.servings).toBeNull();
  });

  it("rejects unbounded nutrition strings and confidence notes", () => {
    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        nutrition: {
          calories: "x".repeat(10_000),
          protein: null,
          carbohydrates: null,
          fat: null,
          fiber: null,
          sugar: null,
          sodium: null
        }
      }).success
    ).toBe(false);

    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        confidence: {
          ...baseRecipe.confidence,
          notes: Array.from({ length: 5_000 }, () => "note")
        }
      }).success
    ).toBe(false);

    expect(
      recipeSchema.safeParse({
        ...baseRecipe,
        confidence: { ...baseRecipe.confidence, notes: ["x".repeat(20_000)] }
      }).success
    ).toBe(false);
  });

  it("still accepts a generous but realistic recipe", () => {
    const parsed = recipeSchema.safeParse({
      ...baseRecipe,
      title: "A".repeat(180),
      ingredients: Array.from({ length: 80 }, (_unused, index) => ({
        section: "Main",
        text: `${index + 1} tablespoons of a very thoroughly described ingredient`
      })),
      steps: Array.from({ length: 60 }, (_unused, index) => ({
        index: index + 1,
        text: "S".repeat(1_500)
      })),
      nutrition: {
        calories: "480 kcal",
        protein: "18 g",
        carbohydrates: "62 g",
        fat: "14 g",
        fiber: "4 g",
        sugar: "6 g",
        sodium: "420 mg"
      },
      confidence: {
        ...baseRecipe.confidence,
        summary: "S".repeat(500),
        notes: Array.from({ length: 10 }, () => "N".repeat(400))
      }
    });

    expect(parsed.success).toBe(true);
  });
});
