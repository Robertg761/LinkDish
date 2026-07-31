import {
  computeMissingRecipeFields,
  type MissingRecipeField,
  type Recipe
} from "../../../../../../packages/recipe-domain/src/index.js";

import type { ExtractionCandidate } from "../types.js";

const strategyBaseScores = {
  "recipe-schema": 0.92,
  "recipe-adapter-dom": 0.82,
  "article-pattern": 0.76,
  "youtube-transcript": 0.74,
  "llm-fallback": 0.8
} as const;

export interface ScoredExtraction {
  confidenceScore: number;
  missingFields: MissingRecipeField[];
}

export const scoreRecipe = (
  recipe: Partial<Recipe>,
  candidate: ExtractionCandidate
): ScoredExtraction => {
  const missingFields = computeMissingRecipeFields(recipe);
  let score = strategyBaseScores[candidate.strategy];

  score -=
    missingFields.filter(
      (field) => field === "servings" || field === "prepTimeMinutes" || field === "cookTimeMinutes"
    ).length * 0.12;

  if (candidate.signals.requiredFieldsInferred) {
    score -= 0.2;
  }

  if (candidate.signals.titleConfidence === "weak") {
    score -= 0.1;
  }

  if (candidate.signals.timesFromStructuredMetadata) {
    score += 0.03;
  }

  if (candidate.signals.detectionConfidence === "medium") {
    score -= 0.05;
  }

  if (candidate.signals.detectionConfidence === "low") {
    score -= 0.12;
  }

  if (candidate.signals.sectionCohesion === "weak") {
    score -= 0.1;
  }

  if (candidate.signals.sectionCohesion === "medium") {
    score -= 0.04;
  }

  if (candidate.signals.usedBrowserFallback) {
    score -= 0.03;
  }

  score -= Math.min(candidate.signals.blockedSourceSignals, 3) * 0.02;

  if (
    candidate.strategy === "youtube-transcript" &&
    candidate.signals.transcriptQuality === "missing"
  ) {
    score -= 0.15;
  }

  return {
    confidenceScore: Math.max(0, Math.min(1, score)),
    missingFields
  };
};
