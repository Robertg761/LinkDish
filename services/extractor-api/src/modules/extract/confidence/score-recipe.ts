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

/*
 * Servings and times are optional metadata. Heuristic extractions lose a lot of confidence when
 * they are missing (their absence often means the page was not really parsed), but a site's own
 * structured recipe data is trusted for what it does say: it only loses a little.
 */
const heuristicMissingFieldPenalty = 0.12;
const structuredMissingFieldPenalty = 0.03;

export interface ScoredExtraction {
  confidenceScore: number;
  missingFields: MissingRecipeField[];
}

const minimumStrongIngredientCount = 2;

/**
 * A recipe the site published as structured data (JSON-LD or microdata) with a title, at least
 * two ingredients and at least one step. These are imported as successes even when servings or
 * times are missing; the gaps become a warning instead of a needs_retry round trip.
 */
export const isStrongStructuredCandidate = (candidate: ExtractionCandidate): boolean =>
  candidate.strategy === "recipe-schema" &&
  !candidate.signals.requiredFieldsInferred &&
  candidate.provenance.some((source) => source === "jsonld" || source === "microdata") &&
  typeof candidate.recipe.title === "string" &&
  candidate.recipe.title.trim().length > 0 &&
  (candidate.recipe.ingredients?.length ?? 0) >= minimumStrongIngredientCount &&
  (candidate.recipe.steps?.length ?? 0) >= 1;

/*
 * Optional fields that count against confidence. A published total time stands in for missing
 * prep and cook times (many sites only give "Total: 45 min").
 */
const countPenalizedMissingFields = (
  recipe: Partial<Recipe>,
  missingFields: MissingRecipeField[]
): number =>
  missingFields.filter((field) => {
    if (field === "servings") {
      return true;
    }

    if (field === "prepTimeMinutes" || field === "cookTimeMinutes") {
      return recipe.totalTimeMinutes == null;
    }

    return false;
  }).length;

export const scoreRecipe = (
  recipe: Partial<Recipe>,
  candidate: ExtractionCandidate
): ScoredExtraction => {
  const missingFields = computeMissingRecipeFields(recipe);
  const missingFieldPenalty = isStrongStructuredCandidate({ ...candidate, recipe })
    ? structuredMissingFieldPenalty
    : heuristicMissingFieldPenalty;
  let score = strategyBaseScores[candidate.strategy];

  score -= countPenalizedMissingFields(recipe, missingFields) * missingFieldPenalty;

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
