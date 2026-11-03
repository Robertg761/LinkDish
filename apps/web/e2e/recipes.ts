import type { ExtractRecipeFailure, ExtractRecipeSuccess } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

/** A recipe as POST /extract returns it, read from a recipe site's JSON-LD. */
export const weeknightRice: Recipe = {
  title: "Weeknight Jasmine Rice",
  sourceUrl: "https://cooking.example.com/weeknight-rice",
  sourceType: "recipe-webpage",
  image: null,
  ingredients: [{ text: "1 cup jasmine rice" }, { text: "2 cups water" }, { text: "1 tsp salt" }],
  steps: [
    { index: 1, text: "Rinse the rice until the water runs clear." },
    { index: 2, text: "Simmer, covered, for 15 minutes." }
  ],
  servings: "4 servings",
  prepTimeMinutes: 5,
  cookTimeMinutes: 20,
  nutrition: null,
  confidence: {
    score: 0.95,
    summary: "High confidence",
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

export const extractSuccess = (recipe: Recipe): ExtractRecipeSuccess => ({
  status: "success",
  recipe,
  extraction: {
    sourceType: recipe.sourceType,
    strategy: "recipe-schema",
    confidenceScore: recipe.confidence.score,
    missingFields: [],
    warnings: [],
    fetchMode: "http",
    provenance: ["jsonld"]
  }
});

export const extractFailure = (reason: ExtractRecipeFailure["reason"]): ExtractRecipeFailure => ({
  status: "failure",
  reason,
  userMessage: "The extractor could not read this page."
});
