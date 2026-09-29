import {
  hasRequiredRecipeFields,
  MAX_RECIPE_INGREDIENT_COUNT,
  MAX_RECIPE_INGREDIENT_SECTION_LENGTH,
  MAX_RECIPE_INGREDIENT_TEXT_LENGTH,
  MAX_RECIPE_NUTRITION_VALUE_LENGTH,
  MAX_RECIPE_SERVINGS_LENGTH,
  MAX_RECIPE_STEP_COUNT,
  MAX_RECIPE_STEP_TEXT_LENGTH,
  MAX_RECIPE_TITLE_LENGTH,
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

/*
 * The response contract caps text lengths and list sizes. A page that breaks them (a whole
 * recipe pasted into one ingredient, 400 "ingredients" from a list page) used to fail response
 * validation and surface as a 500; the candidate is clipped to the contract instead.
 */
const clip = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : value.slice(0, maxLength).trimEnd();

const clipOptional = (value: string | null, maxLength: number): string | null =>
  value == null ? null : clip(value, maxLength) || null;

const decodeNutritionValue = (value: string | null | undefined): string | null =>
  clipOptional(decodeOptionalText(value), MAX_RECIPE_NUTRITION_VALUE_LENGTH);

/**
 * One plain-language note about optional details the source left out, or null when nothing
 * is missing. Missing servings or times never fail an import; they are reported here instead.
 */
export const describeMissingRecipeMetadata = (
  recipe: Pick<Recipe, "servings" | "prepTimeMinutes" | "cookTimeMinutes" | "totalTimeMinutes">
): string | null => {
  const missing: string[] = [];
  const hasPrep = recipe.prepTimeMinutes != null;
  const hasCook = recipe.cookTimeMinutes != null;

  if (!recipe.servings) {
    missing.push("servings");
  }

  if (!hasPrep && !hasCook) {
    if (recipe.totalTimeMinutes == null) {
      missing.push("cooking times");
    }
  } else if (!hasPrep) {
    missing.push("a prep time");
  } else if (!hasCook) {
    missing.push("a cook time");
  }

  return missing.length === 0 ? null : `The source didn't list ${missing.join(" or ")}.`;
};

const decodeMetadataText = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const decoded = decodeText(value).trim();
  return decoded.length > 0 ? decoded : null;
};

/* Optional metadata is copied only when present, so older-shaped recipes stay byte-identical. */
const normalizeMetadata = (candidate: ExtractionCandidate["recipe"]): Partial<Recipe> => {
  const metadata: Partial<Recipe> = {};
  const description = decodeMetadataText(candidate.description);
  const author = decodeMetadataText(candidate.author);
  const siteName = decodeMetadataText(candidate.siteName);
  const cuisine = decodeMetadataText(candidate.cuisine);
  const category = decodeMetadataText(candidate.category);
  const keywords = (candidate.keywords ?? [])
    .map((keyword) => decodeMetadataText(keyword))
    .filter((keyword): keyword is string => keyword !== null);

  if (description) {
    metadata.description = description;
  }

  if (candidate.totalTimeMinutes != null) {
    metadata.totalTimeMinutes = candidate.totalTimeMinutes;
  }

  if (author) {
    metadata.author = author;
  }

  if (siteName) {
    metadata.siteName = siteName;
  }

  if (cuisine) {
    metadata.cuisine = cuisine;
  }

  if (category) {
    metadata.category = category;
  }

  if (keywords.length > 0) {
    metadata.keywords = keywords;
  }

  if (candidate.videoUrl) {
    metadata.videoUrl = candidate.videoUrl;
  }

  return metadata;
};

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
  const missingMetadataNote = describeMissingRecipeMetadata({
    servings: candidate.recipe.servings ?? null,
    prepTimeMinutes: candidate.recipe.prepTimeMinutes ?? null,
    cookTimeMinutes: candidate.recipe.cookTimeMinutes ?? null,
    totalTimeMinutes: candidate.recipe.totalTimeMinutes ?? null
  });
  const decodedWarnings = [
    ...candidate.warnings.map(decodeText),
    ...(missingMetadataNote ? [missingMetadataNote] : [])
  ];
  const ingredients = (candidate.recipe.ingredients ?? [])
    .slice(0, MAX_RECIPE_INGREDIENT_COUNT)
    .map((ingredient) => ({
      section: clipOptional(
        decodeOptionalText(ingredient.section),
        MAX_RECIPE_INGREDIENT_SECTION_LENGTH
      ),
      text: clip(decodeText(ingredient.text), MAX_RECIPE_INGREDIENT_TEXT_LENGTH)
    }))
    .filter((ingredient) => ingredient.text.length > 0);
  const steps = (candidate.recipe.steps ?? [])
    .slice(0, MAX_RECIPE_STEP_COUNT)
    .map((step) => ({
      index: step.index,
      text: clip(decodeText(step.text), MAX_RECIPE_STEP_TEXT_LENGTH)
    }))
    .filter((step) => step.text.length > 0);

  if (ingredients.length === 0 || steps.length === 0) {
    return null;
  }

  const recipe: Recipe = {
    title: clip(decodeText(candidate.recipe.title ?? "Untitled Recipe"), MAX_RECIPE_TITLE_LENGTH),
    sourceUrl,
    sourceType,
    image: candidate.recipe.image ?? null,
    ingredients,
    steps,
    servings: clipOptional(
      decodeOptionalText(candidate.recipe.servings),
      MAX_RECIPE_SERVINGS_LENGTH
    ),
    prepTimeMinutes: candidate.recipe.prepTimeMinutes ?? null,
    cookTimeMinutes: candidate.recipe.cookTimeMinutes ?? null,
    nutrition: candidate.recipe.nutrition
      ? {
          calories: decodeNutritionValue(candidate.recipe.nutrition.calories),
          protein: decodeNutritionValue(candidate.recipe.nutrition.protein),
          carbohydrates: decodeNutritionValue(candidate.recipe.nutrition.carbohydrates),
          fat: decodeNutritionValue(candidate.recipe.nutrition.fat),
          fiber: decodeNutritionValue(candidate.recipe.nutrition.fiber),
          sugar: decodeNutritionValue(candidate.recipe.nutrition.sugar),
          sodium: decodeNutritionValue(candidate.recipe.nutrition.sodium)
        }
      : null,
    confidence: {
      score: confidenceScore,
      summary: decodeText(confidenceSummary),
      missingFields,
      notes: decodedWarnings,
      fieldProvenance: candidate.fieldProvenance
    },
    ...normalizeMetadata(candidate.recipe)
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
