import { describe, expect, it } from "vitest";

import { scoreRecipe } from "./score-recipe";

describe("scoreRecipe", () => {
  it("scores structured recipe data highly", () => {
    const scored = scoreRecipe(
      {
        title: "One-Pan Tomato Pasta",
        sourceUrl: "https://example.com/recipe",
        sourceType: "recipe-webpage",
        ingredients: [{ text: "12 oz spaghetti" }],
        steps: [{ index: 1, text: "Boil the pasta." }],
        servings: "4 servings",
        prepTimeMinutes: 10,
        cookTimeMinutes: 20,
        nutrition: null
      },
      {
        recipe: {},
        strategy: "recipe-schema",
        evidence: [],
        warnings: [],
        provenance: ["jsonld"],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: null
        },
        signals: {
          requiredFieldsInferred: false,
          titleConfidence: "strong",
          timesFromStructuredMetadata: true,
          recipeLike: true,
          detectionConfidence: "high",
          sectionCohesion: "strong",
          transcriptQuality: "weak",
          usedBrowserFallback: false,
          blockedSourceSignals: 0
        }
      }
    );

    expect(scored.confidenceScore).toBeGreaterThan(0.8);
  });

  it("scores heuristic article extraction lower", () => {
    const scored = scoreRecipe(
      {
        title: "Skillet Dinner Notes",
        ingredients: [{ text: "1 lb chicken thighs" }],
        steps: [],
        servings: null,
        prepTimeMinutes: null,
        cookTimeMinutes: null,
        nutrition: null
      },
      {
        recipe: {},
        strategy: "article-pattern",
        evidence: [],
        warnings: [],
        provenance: ["visible-text"],
        fieldProvenance: {
          title: "visible-text",
          ingredients: "visible-text",
          steps: "visible-text",
          servings: null,
          prepTimeMinutes: null,
          cookTimeMinutes: null,
          nutrition: null
        },
        signals: {
          requiredFieldsInferred: true,
          titleConfidence: "weak",
          timesFromStructuredMetadata: false,
          recipeLike: true,
          detectionConfidence: "low",
          sectionCohesion: "weak",
          transcriptQuality: "missing",
          usedBrowserFallback: false,
          blockedSourceSignals: 0
        }
      }
    );

    expect(scored.confidenceScore).toBeLessThan(0.5);
    expect(scored.missingFields).toContain("steps");
  });
});
