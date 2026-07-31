import { load } from "cheerio";

import { getDomainAdapter } from "../../source-detection/domain-adapters.js";
import { captureRecipeImage } from "../capture-recipe-image.js";
import {
  buildFieldProvenance,
  extractMinutesFromText,
  extractItemsFromSelectors,
  extractNutritionFromText,
  extractSectionContent,
  extractSectionListItems,
  parseIsoDurationToMinutes,
  parseServingsText,
  parseTextRecipeSignals,
  toIngredientLines,
  toStepLines,
  uniqueNonEmptyText
} from "../shared.js";

import type { ExtractionCandidate, HtmlSourceDocument } from "../../types.js";

interface JsonLdRecipe {
  name?: string;
  recipeIngredient?: string[];
  recipeInstructions?: Array<string | { text?: string; name?: string }> | string;
  recipeYield?: string | string[];
  prepTime?: string;
  cookTime?: string;
  nutrition?: {
    calories?: string;
    proteinContent?: string;
    carbohydrateContent?: string;
    fatContent?: string;
    fiberContent?: string;
    sugarContent?: string;
    sodiumContent?: string;
  };
}

interface LooseNutritionShape {
  calories: string | null | undefined;
  proteinContent: string | null | undefined;
  carbohydrateContent: string | null | undefined;
  fatContent: string | null | undefined;
  fiberContent: string | null | undefined;
  sugarContent: string | null | undefined;
  sodiumContent: string | null | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const extractJsonLdRecipe = (html: string): JsonLdRecipe | null => {
  const $ = load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();
  const candidates: JsonLdRecipe[] = [];

  for (const script of scripts) {
    const rawValue = $(script).text().trim();

    if (!rawValue) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      const queue: Record<string, unknown>[] = [];

      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isRecord(entry)) {
            queue.push(entry);
          }
        }
      } else if (isRecord(parsed)) {
        queue.push(parsed);
      }

      while (queue.length > 0) {
        const current = queue.shift();

        if (!current) {
          continue;
        }

        if (Array.isArray(current["@graph"])) {
          const graphEntries = current["@graph"] as unknown[];

          for (const entry of graphEntries) {
            if (isRecord(entry)) {
              queue.push(entry);
            }
          }
        }

        const typeValue = current["@type"];
        const types = Array.isArray(typeValue) ? typeValue : [typeValue];

        if (types.some((type) => String(type).toLowerCase() === "recipe")) {
          candidates.push(current as JsonLdRecipe);
        }
      }
    } catch {
      continue;
    }
  }

  return (
    candidates.sort((left, right) => {
      const leftScore =
        (left.recipeIngredient?.length ?? 0) +
        normalizeRecipeInstructions(left.recipeInstructions).length;
      const rightScore =
        (right.recipeIngredient?.length ?? 0) +
        normalizeRecipeInstructions(right.recipeInstructions).length;

      return rightScore - leftScore;
    })[0] ?? null
  );
};

const normalizeRecipeInstructions = (
  instructions: JsonLdRecipe["recipeInstructions"]
): string[] => {
  if (typeof instructions === "string") {
    return instructions
      .split(/\n+/)
      .map((instruction) => instruction.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(instructions)) {
    return [];
  }

  return uniqueNonEmptyText(
    instructions.flatMap((instruction) => {
      if (typeof instruction === "string") {
        return [instruction];
      }

      if (
        "itemListElement" in instruction &&
        Array.isArray((instruction as { itemListElement?: unknown[] }).itemListElement)
      ) {
        return (
          (instruction as { itemListElement?: Array<{ text?: string; name?: string }> })
            .itemListElement ?? []
        )
          .map((entry) => entry.text ?? entry.name ?? "")
          .filter(Boolean);
      }

      return [instruction.text ?? instruction.name ?? ""];
    })
  );
};

const toNullableNutritionValue = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const normalizeNutrition = (
  nutrition: JsonLdRecipe["nutrition"] | LooseNutritionShape | null | undefined
) => {
  if (!nutrition) {
    return null;
  }

  const normalizedNutrition = {
    calories: toNullableNutritionValue(nutrition.calories),
    protein: toNullableNutritionValue(nutrition.proteinContent),
    carbohydrates: toNullableNutritionValue(nutrition.carbohydrateContent),
    fat: toNullableNutritionValue(nutrition.fatContent),
    fiber: toNullableNutritionValue(nutrition.fiberContent),
    sugar: toNullableNutritionValue(nutrition.sugarContent),
    sodium: toNullableNutritionValue(nutrition.sodiumContent)
  };

  const hasAnyNutrition = Object.values(normalizedNutrition).some((value) => value !== null);

  return hasAnyNutrition ? normalizedNutrition : null;
};

export const extractRecipeWebpage = (document: HtmlSourceDocument): ExtractionCandidate | null => {
  const jsonLdRecipe = extractJsonLdRecipe(document.html);
  const $ = load(document.html);
  const pageTitle = $("h1").first().text().trim() || document.title || $("title").text().trim();
  const adapter = getDomainAdapter(new URL(document.finalUrl).hostname.toLowerCase());
  const image = captureRecipeImage(document.html, document.finalUrl);

  if (jsonLdRecipe) {
    return {
      recipe: {
        title: jsonLdRecipe.name ?? pageTitle,
        sourceUrl: document.finalUrl,
        sourceType: "recipe-webpage",
        image,
        ingredients: toIngredientLines(jsonLdRecipe.recipeIngredient ?? []),
        steps: toStepLines(normalizeRecipeInstructions(jsonLdRecipe.recipeInstructions)),
        servings: parseServingsText(
          Array.isArray(jsonLdRecipe.recipeYield)
            ? jsonLdRecipe.recipeYield.join(", ")
            : (jsonLdRecipe.recipeYield ?? null)
        ),
        prepTimeMinutes: parseIsoDurationToMinutes(jsonLdRecipe.prepTime),
        cookTimeMinutes: parseIsoDurationToMinutes(jsonLdRecipe.cookTime),
        nutrition: normalizeNutrition(jsonLdRecipe.nutrition)
      },
      strategy: "recipe-schema",
      evidence: ["Detected Recipe JSON-LD on the page."],
      warnings: [],
      provenance: ["jsonld"],
      fieldProvenance: buildFieldProvenance({
        title: jsonLdRecipe.name ? "jsonld" : "visible-text",
        ingredients: "jsonld",
        steps: "jsonld",
        servings: jsonLdRecipe.recipeYield ? "jsonld" : null,
        prepTimeMinutes: jsonLdRecipe.prepTime ? "jsonld" : null,
        cookTimeMinutes: jsonLdRecipe.cookTime ? "jsonld" : null,
        nutrition: jsonLdRecipe.nutrition ? "jsonld" : null
      }),
      signals: {
        requiredFieldsInferred: false,
        titleConfidence: jsonLdRecipe.name ? "strong" : "weak",
        timesFromStructuredMetadata:
          Boolean(jsonLdRecipe.prepTime) || Boolean(jsonLdRecipe.cookTime),
        recipeLike: true,
        detectionConfidence: "high",
        sectionCohesion: "strong",
        transcriptQuality: "weak",
        usedBrowserFallback: false,
        blockedSourceSignals: document.blockedSignals.length
      }
    };
  }

  const microdataRoot = $('[itemtype*="Recipe"]').first();
  const microdataIngredients = uniqueNonEmptyText(
    microdataRoot
      .find('[itemprop="recipeIngredient"]')
      .toArray()
      .map((node) => $(node).text())
  );
  const microdataSteps = uniqueNonEmptyText(
    microdataRoot
      .find('[itemprop="recipeInstructions"]')
      .toArray()
      .flatMap((node) => {
        const text = $(node).text();
        return text.split(/\n+/);
      })
  );

  if (microdataRoot.length > 0) {
    const microdataNutrition = normalizeNutrition({
      calories: microdataRoot.find('[itemprop="calories"]').first().text().trim() || undefined,
      proteinContent:
        microdataRoot.find('[itemprop="proteinContent"]').first().text().trim() || undefined,
      carbohydrateContent:
        microdataRoot.find('[itemprop="carbohydrateContent"]').first().text().trim() || undefined,
      fatContent: microdataRoot.find('[itemprop="fatContent"]').first().text().trim() || undefined,
      fiberContent:
        microdataRoot.find('[itemprop="fiberContent"]').first().text().trim() || undefined,
      sugarContent:
        microdataRoot.find('[itemprop="sugarContent"]').first().text().trim() || undefined,
      sodiumContent:
        microdataRoot.find('[itemprop="sodiumContent"]').first().text().trim() || undefined
    });

    return {
      recipe: {
        title: microdataRoot.find('[itemprop="name"]').first().text().trim() || pageTitle,
        sourceUrl: document.finalUrl,
        sourceType: "recipe-webpage",
        image,
        ingredients: toIngredientLines(microdataIngredients),
        steps: toStepLines(microdataSteps),
        servings: parseServingsText(
          microdataRoot.find('[itemprop="recipeYield"]').first().text().trim() || null
        ),
        prepTimeMinutes:
          parseIsoDurationToMinutes(microdataRoot.find('[itemprop="prepTime"]').attr("content")) ??
          parseIsoDurationToMinutes(microdataRoot.find('[itemprop="totalTime"]').attr("content")),
        cookTimeMinutes:
          parseIsoDurationToMinutes(microdataRoot.find('[itemprop="cookTime"]').attr("content")) ??
          parseIsoDurationToMinutes(microdataRoot.find('[itemprop="totalTime"]').attr("content")),
        nutrition: microdataNutrition ?? extractNutritionFromText(microdataRoot.text())
      },
      strategy: "recipe-schema",
      evidence: ["Detected recipe microdata on the page."],
      warnings: ["Recipe JSON-LD was unavailable, so microdata was used instead."],
      provenance: ["microdata", ...(microdataNutrition ? [] : ["visible-text" as const])],
      fieldProvenance: buildFieldProvenance({
        title: "microdata",
        ingredients: "microdata",
        steps: "microdata",
        servings: microdataRoot.find('[itemprop="recipeYield"]').first().text().trim()
          ? "microdata"
          : null,
        prepTimeMinutes: microdataRoot.find('[itemprop="prepTime"]').attr("content")
          ? "microdata"
          : null,
        cookTimeMinutes:
          microdataRoot.find('[itemprop="cookTime"]').attr("content") ||
          microdataRoot.find('[itemprop="totalTime"]').attr("content")
            ? "microdata"
            : null,
        nutrition: microdataNutrition
          ? "microdata"
          : microdataRoot.text().trim()
            ? "visible-text"
            : null
      }),
      signals: {
        requiredFieldsInferred: false,
        titleConfidence: "strong",
        timesFromStructuredMetadata: true,
        recipeLike: true,
        detectionConfidence: "high",
        sectionCohesion: "strong",
        transcriptQuality: "weak",
        usedBrowserFallback: false,
        blockedSourceSignals: document.blockedSignals.length
      }
    };
  }

  const adapterIngredientItems = adapter
    ? extractItemsFromSelectors(document.html, adapter.selectors.ingredients)
    : [];
  const adapterStepItems = adapter
    ? extractItemsFromSelectors(document.html, adapter.selectors.steps)
    : [];
  const ingredientItems =
    adapterIngredientItems.length > 0
      ? adapterIngredientItems
      : [
          ...extractSectionListItems(document.html, /ingredients?/i),
          ...extractSectionContent(document.html, /ingredients?/i)
        ];
  const stepItems =
    adapterStepItems.length > 0
      ? adapterStepItems
      : [
          ...extractSectionListItems(document.html, /(instructions?|directions?|method)/i),
          ...extractSectionContent(document.html, /(instructions?|directions?|method|steps?)/i)
        ];
  const textSignals = parseTextRecipeSignals([...ingredientItems, ...stepItems]);
  const combinedText = $.text();

  if (!textSignals.signals.recipeLike) {
    return null;
  }

  return {
    recipe: {
      title: pageTitle,
      sourceUrl: document.finalUrl,
      sourceType: "recipe-webpage",
      image,
      ingredients: toIngredientLines(ingredientItems),
      steps: toStepLines(stepItems),
      servings: parseServingsText($.text().match(/yield[:\s]+([^\n.]+)/i)?.[1] ?? null),
      prepTimeMinutes: extractMinutesFromText(combinedText, "prep"),
      cookTimeMinutes: extractMinutesFromText(combinedText, "cook"),
      nutrition: extractNutritionFromText(combinedText)
    },
    strategy: "recipe-adapter-dom",
    evidence: [
      adapter
        ? `Used adapter-aware selectors for ${adapter.key} after structured recipe metadata was unavailable.`
        : "Used section-based heuristics after structured recipe metadata was unavailable."
    ],
    warnings: ["Recipe details were inferred from visible page sections."],
    provenance: ["visible-text"],
    fieldProvenance: buildFieldProvenance({
      title: "visible-text",
      ingredients: "visible-text",
      steps: "visible-text",
      servings: $.text().match(/yield[:\s]+([^\n.]+)/i)?.[1] ? "visible-text" : null,
      prepTimeMinutes: extractMinutesFromText(combinedText, "prep") == null ? null : "visible-text",
      cookTimeMinutes: extractMinutesFromText(combinedText, "cook") == null ? null : "visible-text",
      nutrition: extractNutritionFromText(combinedText) ? "visible-text" : null
    }),
    signals: textSignals.signals
  };
};
