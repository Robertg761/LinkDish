import { describe, expect, it } from "vitest";

import { isStrongStructuredCandidate, scoreRecipe } from "./score-recipe";
import { successConfidenceThresholds } from "./thresholds";

import type { ExtractionCandidate } from "../types";

const structuredCandidate = (
  recipe: ExtractionCandidate["recipe"],
  overrides: Partial<ExtractionCandidate> = {}
): ExtractionCandidate => ({
  recipe,
  strategy: "recipe-schema",
  evidence: [],
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
  },
  ...overrides
});

const recipe = {
  title: "Quick Slaw",
  ingredients: [{ text: "2 cups cabbage" }, { text: "1 carrot" }],
  steps: [{ index: 1, text: "Toss." }],
  servings: null,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  nutrition: null
};

const score = (candidate: ExtractionCandidate) =>
  scoreRecipe(candidate.recipe, candidate).confidenceScore;

describe("strong structured recipes", () => {
  it("identifies JSON-LD/microdata recipes with a title, two ingredients and a step", () => {
    expect(isStrongStructuredCandidate(structuredCandidate(recipe))).toBe(true);
    expect(
      isStrongStructuredCandidate(structuredCandidate(recipe, { provenance: ["microdata"] }))
    ).toBe(true);
    expect(
      isStrongStructuredCandidate(
        structuredCandidate({ ...recipe, ingredients: [{ text: "2 cups cabbage" }] })
      )
    ).toBe(false);
    expect(isStrongStructuredCandidate(structuredCandidate({ ...recipe, steps: [] }))).toBe(false);
    expect(
      isStrongStructuredCandidate(
        structuredCandidate(recipe, {
          strategy: "recipe-adapter-dom",
          provenance: ["visible-text"]
        })
      )
    ).toBe(false);
  });

  it("clears the success bar even with servings and both times missing", () => {
    expect(score(structuredCandidate(recipe))).toBeGreaterThanOrEqual(
      successConfidenceThresholds["recipe-webpage"]
    );
  });

  it("scores a totalTime-only recipe as confident as one with prep and cook", () => {
    const withTotal = structuredCandidate({ ...recipe, servings: "4", totalTimeMinutes: 45 });
    const withPrepAndCook = structuredCandidate({
      ...recipe,
      servings: "4",
      prepTimeMinutes: 15,
      cookTimeMinutes: 30
    });

    expect(score(withTotal)).toBe(score(withPrepAndCook));
  });

  it("still penalises missing metadata heavily for heuristic extractions", () => {
    const heuristic = structuredCandidate(recipe, {
      strategy: "article-pattern",
      provenance: ["readability", "visible-text"]
    });

    expect(score(heuristic)).toBeLessThan(successConfidenceThresholds.article);
  });
});
