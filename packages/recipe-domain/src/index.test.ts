import { describe, expect, it } from "vitest";

import {
  buildMissingFieldSummary,
  computeMissingRecipeFields,
  hasRequiredRecipeFields,
  recipeSchema
} from "./index";

describe("recipeSchema", () => {
  it("accepts a fully structured recipe", () => {
    const parsed = recipeSchema.parse({
      title: "Lemon Pasta",
      sourceUrl: "https://example.com/lemon-pasta",
      sourceType: "recipe-webpage",
      ingredients: [{ text: "200g pasta" }],
      steps: [{ index: 1, text: "Boil the pasta." }],
      servings: "2 servings",
      prepTimeMinutes: 10,
      cookTimeMinutes: 15,
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
        score: 0.94,
        summary: "Structured recipe data was present.",
        missingFields: [],
        notes: ["Times inferred from the article intro."],
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
    });

    expect(parsed.title).toBe("Lemon Pasta");
    expect(parsed.image).toBeNull();
  });

  it("accepts captured recipe image metadata", () => {
    const parsed = recipeSchema.parse({
      title: "Lemon Pasta",
      sourceUrl: "https://example.com/lemon-pasta",
      sourceType: "recipe-webpage",
      image: {
        url: "https://cdn.example.com/lemon-pasta.webp",
        width: 1200,
        height: 900,
        source: "jsonld"
      },
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
    });

    expect(parsed.image).toEqual({
      height: 900,
      source: "jsonld",
      url: "https://cdn.example.com/lemon-pasta.webp",
      width: 1200
    });
  });

  it("accepts field provenance in recipe confidence", () => {
    const parsed = recipeSchema.parse({
      title: "Lemon Pasta",
      sourceUrl: "https://example.com/lemon-pasta",
      sourceType: "article",
      ingredients: [{ text: "200g pasta" }],
      steps: [{ index: 1, text: "Boil the pasta." }],
      servings: null,
      prepTimeMinutes: null,
      cookTimeMinutes: null,
      nutrition: null,
      confidence: {
        score: 0.8,
        summary: "Visible text extraction succeeded.",
        missingFields: ["servings", "prepTimeMinutes", "cookTimeMinutes"],
        notes: [],
        fieldProvenance: {
          title: "visible-text",
          ingredients: "visible-text",
          steps: "visible-text",
          servings: null,
          prepTimeMinutes: null,
          cookTimeMinutes: null,
          nutrition: null
        }
      }
    });

    expect(parsed.confidence.fieldProvenance.ingredients).toBe("visible-text");
  });

  it("computes missing metadata fields", () => {
    expect(
      computeMissingRecipeFields({
        ingredients: [],
        steps: [{ index: 1, text: "Mix." }],
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: 20
      })
    ).toEqual(["ingredients", "servings", "prepTimeMinutes"]);
  });

  it("detects whether required fields are present", () => {
    expect(
      hasRequiredRecipeFields({
        title: "Lemon Pasta",
        ingredients: [{ text: "200g pasta" }],
        steps: [{ index: 1, text: "Boil." }]
      })
    ).toBe(true);

    expect(
      hasRequiredRecipeFields({
        title: "",
        ingredients: [{ text: "200g pasta" }],
        steps: [{ index: 1, text: "Boil." }]
      })
    ).toBe(false);
  });

  it("builds a human-readable missing field summary", () => {
    expect(
      buildMissingFieldSummary({
        ingredients: [],
        steps: [],
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: null
      })
    ).toContain("Missing required fields");
  });
});
