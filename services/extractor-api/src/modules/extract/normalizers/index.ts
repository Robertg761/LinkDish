import {
  hasRequiredRecipeFields,
  type Recipe,
  type SourceType
} from "../../../../../../packages/recipe-domain/src/index.js";
import { decodeHtmlEntities } from "../../../../../../packages/utils/src/index.js";
import { scoreRecipe } from "../confidence/score-recipe.js";

import type { FetchMode } from "../../../../../../packages/api-contracts/src/index.js";
import type { ExtractionCandidate, NormalizedExtraction } from "../types.js";

const decodeText = (value: string) => decodeHtmlEntities(value).replace(/\u00a0/gu, " ");

const decodeOptionalText = (value: string | null | undefined) =>
  value == null ? null : decodeText(value);

export const normalizeExtractionCandidate = (
  candidate: ExtractionCandidate,
  sourceType: SourceType,
  sourceUrl: string,
  fetchMode: FetchMode
): NormalizedExtraction | null => {
  if (!hasRequiredRecipeFields(candidate.recipe)) {
    return null;
  }

  const { confidenceScore, missingFields } = scoreRecipe(candidate.recipe, candidate);
  const confidenceSummary =
    candidate.evidence.filter((entry) => entry.trim().length > 0).join(" ") ||
    (candidate.strategy === "llm-fallback"
      ? "Fallback extraction produced a structured recipe candidate."
      : "Structured recipe evidence was detected.");
  const decodedWarnings = candidate.warnings.map(decodeText);

  const recipe: Recipe = {
    title: decodeText(candidate.recipe.title ?? "Untitled Recipe"),
    sourceUrl,
    sourceType,
    image: candidate.recipe.image ?? null,
    ingredients:
      candidate.recipe.ingredients?.map((ingredient) => ({
        section: decodeOptionalText(ingredient.section),
        text: decodeText(ingredient.text)
      })) ?? [],
    steps:
      candidate.recipe.steps?.map((step) => ({
        index: step.index,
        text: decodeText(step.text)
      })) ?? [],
    servings: decodeOptionalText(candidate.recipe.servings),
    prepTimeMinutes: candidate.recipe.prepTimeMinutes ?? null,
    cookTimeMinutes: candidate.recipe.cookTimeMinutes ?? null,
    nutrition: candidate.recipe.nutrition
      ? {
          calories: decodeOptionalText(candidate.recipe.nutrition.calories),
          protein: decodeOptionalText(candidate.recipe.nutrition.protein),
          carbohydrates: decodeOptionalText(candidate.recipe.nutrition.carbohydrates),
          fat: decodeOptionalText(candidate.recipe.nutrition.fat),
          fiber: decodeOptionalText(candidate.recipe.nutrition.fiber),
          sugar: decodeOptionalText(candidate.recipe.nutrition.sugar),
          sodium: decodeOptionalText(candidate.recipe.nutrition.sodium)
        }
      : null,
    confidence: {
      score: confidenceScore,
      summary: decodeText(confidenceSummary),
      missingFields,
      notes: decodedWarnings,
      fieldProvenance: candidate.fieldProvenance
    }
  };

  return {
    recipe,
    warnings: decodedWarnings,
    confidenceScore,
    missingFields,
    strategy: candidate.strategy,
    sourceType,
    fetchMode,
    provenance: candidate.provenance
  };
};
