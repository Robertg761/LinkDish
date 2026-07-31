import { load } from "cheerio";

import type {
  RecipeFieldProvenance,
  RecipeNutrition
} from "../../../../../../packages/recipe-domain/src/index.js";
import type { ExtractionCandidate } from "../types.js";

const ingredientPattern =
  /(^|\s)(\d+([/.]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|oz|ounce|ounces|g|gram|grams|kg|ml|l|lb|lbs|clove|cloves|can|cans|package|packages)/i;

const stepVerbPattern =
  /^(add|bake|blend|boil|braise|broil|combine|cook|drain|fold|fry|grill|heat|knead|marinate|mix|pour|prepare|preheat|reduce|reserve|roast|saute|season|serve|simmer|stir|toast|transfer|whisk)\b/i;

export const uniqueNonEmptyText = (values: string[]): string[] => {
  const seen = new Set<string>();

  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => {
      if (value.length === 0 || seen.has(value)) {
        return false;
      }

      seen.add(value);
      return true;
    });
};

export const parseIsoDurationToMinutes = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);

  if (!match) {
    return null;
  }

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);

  return days * 24 * 60 + hours * 60 + minutes;
};

export const parseTimeTextToMinutes = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  const hours = normalized.match(/(\d+)\s*h(?:our|ours)?/);
  const minutes = normalized.match(/(\d+)\s*m(?:in|ins|inute|inutes)?/);

  if (!hours && !minutes) {
    return null;
  }

  return Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
};

export const parseServingsText = (value: unknown): string | null => {
  if (!value) {
    return null;
  }

  const normalizedValue =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : null;

  if (!normalizedValue) {
    return null;
  }

  const trimmed = normalizedValue.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildFieldProvenance = (source: {
  title: RecipeFieldProvenance["title"];
  ingredients: RecipeFieldProvenance["ingredients"];
  steps: RecipeFieldProvenance["steps"];
  servings?: Exclude<RecipeFieldProvenance["servings"], null> | null;
  prepTimeMinutes?: Exclude<RecipeFieldProvenance["prepTimeMinutes"], null> | null;
  cookTimeMinutes?: Exclude<RecipeFieldProvenance["cookTimeMinutes"], null> | null;
  nutrition?: Exclude<RecipeFieldProvenance["nutrition"], null> | null;
}): RecipeFieldProvenance => ({
  title: source.title,
  ingredients: source.ingredients,
  steps: source.steps,
  servings: source.servings ?? null,
  prepTimeMinutes: source.prepTimeMinutes ?? null,
  cookTimeMinutes: source.cookTimeMinutes ?? null,
  nutrition: source.nutrition ?? null
});

export const extractSectionListItems = (html: string, headingPattern: RegExp): string[] => {
  const $ = load(html);
  const headings = $("h1, h2, h3, h4, strong, b").toArray();

  for (const heading of headings) {
    const text = $(heading).text().trim();

    if (!headingPattern.test(text)) {
      continue;
    }

    const siblingLists: string[] = [];
    let sibling = $(heading).next();

    while (sibling.length > 0) {
      if (sibling.is("h1, h2, h3, h4")) {
        break;
      }

      if (sibling.is("ul, ol")) {
        sibling.find("li").each((_, item) => {
          siblingLists.push($(item).text());
        });
      }

      sibling = sibling.next();
    }

    const normalized = uniqueNonEmptyText(siblingLists);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
};

export const extractSectionContent = (html: string, headingPattern: RegExp): string[] => {
  const $ = load(html);
  const headings = $("h1, h2, h3, h4, strong, b").toArray();

  for (const heading of headings) {
    const text = $(heading).text().trim();

    if (!headingPattern.test(text)) {
      continue;
    }

    const section: string[] = [];
    let sibling = $(heading).next();

    while (sibling.length > 0) {
      if (sibling.is("h1, h2, h3, h4")) {
        break;
      }

      if (sibling.is("ul, ol")) {
        sibling.find("li").each((_, item) => {
          section.push($(item).text());
        });
      } else if (sibling.is("p, div")) {
        section.push(sibling.text());
      }

      sibling = sibling.next();
    }

    const normalized = uniqueNonEmptyText(section);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
};

export const extractItemsFromSelectors = (html: string, selectors: string[]): string[] => {
  const $ = load(html);
  const items: string[] = [];

  for (const selector of selectors) {
    $(selector).each((_, node) => {
      const element = $(node);

      if (element.is("ul, ol")) {
        element.find("li").each((__, item) => {
          items.push($(item).text());
        });
        return;
      }

      if (element.children("li").length > 0) {
        element.children("li").each((__, item) => {
          items.push($(item).text());
        });
        return;
      }

      items.push(element.text());
    });
  }

  return uniqueNonEmptyText(items);
};

export const extractTextBlocks = (html: string): string[] => {
  const $ = load(html);

  return uniqueNonEmptyText(
    $("p, li")
      .toArray()
      .map((node) => $(node).text())
  );
};

export const looksLikeIngredient = (value: string): boolean =>
  ingredientPattern.test(value) || value.includes(",");

export const looksLikeStep = (value: string): boolean =>
  /^\d+\./.test(value) || stepVerbPattern.test(value);

const sanitizeIngredientText = (value: string): string => {
  let normalized = value.replace(/\s+/g, " ").trim();
  let previous = "";

  while (normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(/\(\(\s*([^()]+?)\s*\)\)/g, "($1)");
  }

  return normalized
    .replace(/\(\s*,\s*([^()]+?)\s*\)/g, ", $1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
};

export const toIngredientLines = (values: string[]): { text: string }[] =>
  uniqueNonEmptyText(values.map(sanitizeIngredientText))
    .filter((value) => looksLikeIngredient(value) || value.length > 6)
    .map((text) => ({ text }));

const splitInstructionText = (value: string): string[] => {
  const lineParts = value
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return lineParts.flatMap((line) => {
    const markerPattern = /(?:^|\s)(?:step\s*)?\d{1,2}[).:]\s+/gi;
    const markers = [...line.matchAll(markerPattern)].map((match) => {
      const rawMarker = match[0];
      const leadingWhitespaceLength = rawMarker.match(/^\s+/)?.[0].length ?? 0;

      return {
        start: match.index + leadingWhitespaceLength,
        end: match.index + rawMarker.length
      };
    });

    if (markers.length < 2) {
      return [line];
    }

    return markers
      .map((marker, index) => {
        const nextMarker = markers[index + 1];
        return line.slice(marker.end, nextMarker?.start).trim();
      })
      .filter(Boolean);
  });
};

export const toStepLines = (values: string[]): { index: number; text: string }[] =>
  uniqueNonEmptyText(values.flatMap(splitInstructionText))
    .filter((value) => looksLikeStep(value) || value.length > 20)
    .map((text, index) => ({
      index: index + 1,
      text: text.replace(/^\d+\.\s*/, "")
    }));

export const parseTextRecipeSignals = (
  textBlocks: string[]
): Pick<ExtractionCandidate, "warnings" | "signals"> => ({
  warnings: [],
  signals: {
    requiredFieldsInferred: true,
    titleConfidence: "weak",
    timesFromStructuredMetadata: false,
    recipeLike: textBlocks.some((block) => looksLikeIngredient(block) || looksLikeStep(block)),
    detectionConfidence: "low",
    sectionCohesion: textBlocks.length >= 6 ? "medium" : "weak",
    transcriptQuality: "missing",
    usedBrowserFallback: false,
    blockedSourceSignals: 0
  }
});

export const extractServingsFromText = (value: string): string | null => {
  const match = value.match(/(\d+\s*(?:to\s*\d+)?\s*(?:servings?|people))/i);
  return match?.[1] ?? null;
};

export const extractMinutesFromText = (value: string, label: "prep" | "cook"): number | null => {
  const regex =
    label === "prep" ? /prep(?:\s+time)?[:\s]+([^\n.]+)/i : /cook(?:\s+time)?[:\s]+([^\n.]+)/i;

  const match = value.match(regex);
  return parseTimeTextToMinutes(match?.[1] ?? null);
};

const nutritionMatchers = {
  calories: /\bcalories?\b[:\s]*([0-9]+(?:\s*kcal|(?:\s*calories?)?)?)/i,
  protein: /\bprotein\b[:\s]*([0-9]+(?:\.\d+)?\s*g)/i,
  carbohydrates: /\b(?:carbohydrates?|carbs?)\b[:\s]*([0-9]+(?:\.\d+)?\s*g)/i,
  fat: /\bfat\b[:\s]*([0-9]+(?:\.\d+)?\s*g)/i,
  fiber: /\bfib(?:er|re)\b[:\s]*([0-9]+(?:\.\d+)?\s*g)/i,
  sugar: /\bsugars?\b[:\s]*([0-9]+(?:\.\d+)?\s*g)/i,
  sodium: /\bsodium\b[:\s]*([0-9]+(?:\.\d+)?\s*(?:mg|g))/i
} as const;

const normalizeNutritionValue = (
  key: keyof typeof nutritionMatchers,
  value: string | undefined
): string | null => {
  const trimmed = value?.replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return null;
  }

  if (key === "calories" && /^\d+$/.test(trimmed)) {
    return `${trimmed} calories`;
  }

  return trimmed;
};

export const extractNutritionFromText = (value: string): RecipeNutrition | null => {
  const nutrition: RecipeNutrition = {
    calories: normalizeNutritionValue("calories", value.match(nutritionMatchers.calories)?.[1]),
    protein: normalizeNutritionValue("protein", value.match(nutritionMatchers.protein)?.[1]),
    carbohydrates: normalizeNutritionValue(
      "carbohydrates",
      value.match(nutritionMatchers.carbohydrates)?.[1]
    ),
    fat: normalizeNutritionValue("fat", value.match(nutritionMatchers.fat)?.[1]),
    fiber: normalizeNutritionValue("fiber", value.match(nutritionMatchers.fiber)?.[1]),
    sugar: normalizeNutritionValue("sugar", value.match(nutritionMatchers.sugar)?.[1]),
    sodium: normalizeNutritionValue("sodium", value.match(nutritionMatchers.sodium)?.[1])
  };

  return Object.values(nutrition).some((entry) => entry !== null) ? nutrition : null;
};
