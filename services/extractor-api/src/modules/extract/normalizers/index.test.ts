import { describe, expect, it } from "vitest";

import { normalizeExtractionCandidate } from "./index";

describe("normalizeExtractionCandidate", () => {
  it("decodes HTML entities in recipe fields", () => {
    const normalized = normalizeExtractionCandidate(
      {
        recipe: {
          title: "Grandma&#8217;s Granola",
          ingredients: [{ section: "Granola&nbsp;base", text: "1 &frac12; cups oats" }],
          steps: [{ index: 1, text: "Don&#8217;t stir too often." }],
          servings: "Makes&nbsp;8",
          prepTimeMinutes: 5,
          cookTimeMinutes: 21,
          nutrition: {
            calories: "313&nbsp;calories",
            protein: null,
            carbohydrates: null,
            fat: null,
            fiber: null,
            sugar: null,
            sodium: null
          }
        },
        strategy: "recipe-schema",
        evidence: ["Recipe&#8217;s JSON-LD was found."],
        warnings: ["Use &amp; store airtight."],
        provenance: ["jsonld"],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        },
        signals: {
          requiredFieldsInferred: false,
          titleConfidence: "strong",
          timesFromStructuredMetadata: true,
          recipeLike: true,
          detectionConfidence: "high",
          sectionCohesion: "strong",
          transcriptQuality: "missing",
          usedBrowserFallback: false,
          blockedSourceSignals: 0
        }
      },
      "recipe-webpage",
      "https://example.com/granola",
      "http"
    );

    expect(normalized).not.toBeNull();
    expect(normalized?.recipe.title).toBe("Grandma’s Granola");
    expect(normalized?.recipe.ingredients[0]?.section).toBe("Granola base");
    expect(normalized?.recipe.ingredients[0]?.text).toBe("1 ½ cups oats");
    expect(normalized?.recipe.steps[0]?.text).toBe("Don’t stir too often.");
    expect(normalized?.recipe.servings).toBe("Makes 8");
    expect(normalized?.recipe.nutrition?.calories).toBe("313 calories");
    expect(normalized?.warnings).toEqual(["Use & store airtight."]);
    expect(normalized?.recipe.confidence.summary).toBe("Recipe’s JSON-LD was found.");
  });
});
