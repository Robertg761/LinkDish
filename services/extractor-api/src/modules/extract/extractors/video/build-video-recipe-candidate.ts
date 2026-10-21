import type { VideoRecipeContext, VideoRecipePayload } from "./video-recipe-payload.js";
import type { Recipe } from "../../../../../../../packages/recipe-domain/src/index.js";
import type { ExtractionCandidate } from "../../types.js";

/*
 * Turns Gemini's reading of a video into a recipe, keeping only what its own evidence supports.
 * The model quotes the words it heard or read for every ingredient; an ingredient whose name is
 * not in its quote is dropped, and an amount whose numbers are not in its quote loses the amount
 * (the ingredient stays, with the gap listed in the warnings). Ingredients the video only shows
 * never get an amount. A reading with fewer than two ingredients or no step is no recipe.
 */

const minimumIngredientCount = 2;
const maxQuoteChars = 600;

const numberWords: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
  half: 0.5,
  halves: 0.5,
  third: 1 / 3,
  thirds: 1 / 3,
  quarter: 0.25,
  quarters: 0.25
};

/* Unit spellings, by unit: an amount's unit must be the one its quote says. */
const unitFamilies: string[][] = [
  ["cup", "cups", "c"],
  ["tablespoon", "tablespoons", "tbsp", "tbs", "tbl", "tbsps"],
  ["teaspoon", "teaspoons", "tsp", "tsps"],
  ["ounce", "ounces", "oz"],
  ["pound", "pounds", "lb", "lbs"],
  ["gram", "grams", "g", "gr"],
  ["kilogram", "kilograms", "kg", "kilo", "kilos"],
  ["milliliter", "milliliters", "millilitre", "millilitres", "ml"],
  ["liter", "liters", "litre", "litres", "l"],
  ["clove", "cloves"],
  ["can", "cans", "tin", "tins"],
  ["stick", "sticks"],
  ["pinch", "pinches"],
  ["slice", "slices"]
];
const unitFamilyOf = new Map(
  unitFamilies.flatMap((family, index) => family.map((spelling) => [spelling, index] as const))
);

/* Words in an amount that say nothing about which ingredient or how much. */
const amountFillerWords = new Set(["of", "or", "to", "the", "and", "about", "around", "roughly"]);

const nameStopWords = new Set([
  "and",
  "the",
  "for",
  "with",
  "fresh",
  "freshly",
  "chopped",
  "minced",
  "diced",
  "sliced",
  "grated",
  "ground",
  "large",
  "small",
  "medium",
  "optional",
  "taste",
  "some",
  "any",
  "your",
  "favorite",
  "favourite"
]);

/* NFKC spells "½" as "1⁄2", so a digit before one ("1½") is split off first. */
const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/(\d)([½⅓⅔¼¾⅛⅜⅝⅞])/gu, "$1 $2")
    .normalize("NFKC")
    .replace(/\u2044/gu, "/")
    .replace(/[’']/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/* A crude stem so "tomatoes" in the item matches "tomato" in the quote. */
const stem = (word: string): string =>
  word
    .replace(/(?:ies)$/u, "y")
    .replace(/(?:oes|es|s)$/u, (suffix) => (suffix === "oes" ? "o" : ""));

const wordsOf = (value: string): string[] => normalize(value).match(/\p{L}+/gu) ?? [];

/*
 * The amounts a text states, as numbers: digits, fractions, ranges and number words. A mixed
 * number ("1 1/2", "one and a half") is one quantity, its sum.
 */
const readQuantities = (
  value: string,
  articlesCount = true
): { quantity: number; parts: number[] }[] => {
  const tokens = normalize(value).match(/\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|\p{L}+/gu) ?? [];
  const quantities: { quantity: number; parts: number[] }[] = [];
  let previousWasNumber = false;

  for (const token of tokens) {
    let current: number | null = null;

    if (/^\d+\s*\/\s*\d+$/u.test(token)) {
      const [numerator = 0, denominator = 0] = token.split("/").map((part) => Number(part.trim()));
      current = denominator ? numerator / denominator : null;
    } else if (/^\d/u.test(token)) {
      current = Number(token.replace(",", "."));
    } else if (token in numberWords && (articlesCount || (token !== "a" && token !== "an"))) {
      current = numberWords[token] ?? null;
    } else if (token === "and" && previousWasNumber) {
      continue;
    }

    if (current === null || !Number.isFinite(current)) {
      previousWasNumber = false;
      continue;
    }

    const last = quantities.at(-1);

    /* "1 1/2" and "one and a half" (but not "1/2 1/2" or "2 3") are one amount. */
    if (previousWasNumber && last && last.parts.length === 1 && last.quantity >= 1 && current < 1) {
      last.parts.push(current);
      last.quantity += current;
    } else {
      quantities.push({ quantity: current, parts: [current] });
    }

    previousWasNumber = true;
  }

  return quantities;
};

/** Every number a text states, mixed numbers both whole and as their parts. */
export const readStatedNumbers = (value: string): number[] =>
  readQuantities(value).flatMap(({ quantity, parts }) =>
    parts.length > 1 ? [quantity, ...parts] : [quantity]
  );

const sameNumber = (left: number, right: number): boolean => Math.abs(left - right) < 0.01;

/* Does the quote state the amount: each of its numbers, or for "a pinch" its own words. */
export const isAmountSupported = (amount: string, quote: string): boolean => {
  /* "a pinch" is checked by its words; "a cup" in the quote still states 1 cup. */
  const amountQuantities = readQuantities(amount, false).map(({ quantity }) => quantity);

  if (amountQuantities.length > 0) {
    const stated = readStatedNumbers(quote);
    const quoteUnits = new Set(wordsOf(quote).map((word) => unitFamilyOf.get(word)));
    const amountUnits = wordsOf(amount)
      .map((word) => unitFamilyOf.get(word))
      .filter((unit) => unit !== undefined);

    return (
      amountQuantities.every((value) => stated.some((number) => sameNumber(number, value))) &&
      amountUnits.every((unit) => quoteUnits.has(unit))
    );
  }

  const quoteWords = new Set(wordsOf(quote).map(stem));
  const amountWords = wordsOf(amount).filter((word) => !amountFillerWords.has(word));

  return amountWords.length > 0 && amountWords.some((word) => quoteWords.has(stem(word)));
};

/* Does the quote name the ingredient: one of its meaningful words, loosely stemmed. */
export const isItemNamedIn = (item: string, quote: string): boolean => {
  const quoteWords = new Set(wordsOf(quote).map(stem));
  const itemWords = wordsOf(item).filter((word) => word.length >= 3 && !nameStopWords.has(word));
  const candidates = itemWords.length > 0 ? itemWords : wordsOf(item);

  return candidates.some((word) => quoteWords.has(stem(word)));
};

const tidy = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/gu, " ").trim();

export interface VideoRecipeCandidateOptions {
  context: VideoRecipeContext;
  /** Used when the video names no dish. */
  fallbackTitle: string;
  /** Extra recipe fields from the source: image, site, video, author. */
  recipe: Partial<Recipe>;
}

export interface VideoRecipeCandidateResult {
  candidate: ExtractionCandidate | null;
  /** Why ingredients, amounts or the whole reading were set aside, for logs and measurement. */
  rejections: string[];
}

export const buildVideoRecipeCandidate = (
  payload: VideoRecipePayload,
  options: VideoRecipeCandidateOptions
): VideoRecipeCandidateResult => {
  const rejections: string[] = [];

  if (!payload.recipeInVideo) {
    return {
      candidate: null,
      rejections: [`not a recipe: ${tidy(payload.notRecipeReason) || "no reason given"}`]
    };
  }

  const caption = options.context.caption ?? "";
  const ingredients: { text: string; section: string | null }[] = [];
  const withoutAmounts: string[] = [];
  const seen = new Set<string>();

  for (const ingredient of payload.ingredients) {
    const item = tidy(ingredient.item);
    const quote = tidy(ingredient.quote).slice(0, maxQuoteChars);

    if (!item || !quote) {
      rejections.push(`ingredient without evidence: ${item || "(blank)"}`);
      continue;
    }

    /* A caption quote must be in the caption; spoken and on-screen quotes must name the item. */
    const named =
      ingredient.source === "visual"
        ? true
        : ingredient.source === "caption"
          ? isItemNamedIn(item, caption)
          : isItemNamedIn(item, quote);

    if (!named) {
      rejections.push(`ingredient not in its quote: ${item} <- "${quote}"`);
      continue;
    }

    let amount = tidy(ingredient.amount);

    if (amount && ingredient.source === "visual") {
      rejections.push(`amount for an ingredient only shown: ${amount} ${item}`);
      amount = "";
    } else if (
      amount &&
      !isAmountSupported(amount, ingredient.source === "caption" ? caption : quote)
    ) {
      rejections.push(`amount not in its quote: ${amount} ${item} <- "${quote}"`);
      amount = "";
    }

    const text = amount ? `${amount} ${item}` : item;
    const key = normalize(text);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (!amount) {
      withoutAmounts.push(item);
    }

    ingredients.push({ text, section: tidy(ingredient.section) || null });
  }

  const steps = payload.steps
    .filter((step) => tidy(step.text) && tidy(step.quote))
    .map((step, index) => ({ index: index + 1, text: tidy(step.text) }));

  if (ingredients.length < minimumIngredientCount || steps.length === 0) {
    rejections.push(
      `too little left: ${ingredients.length} ingredients, ${steps.length} steps after checks`
    );
    return { candidate: null, rejections };
  }

  const title = tidy(payload.title) || tidy(options.context.title) || options.fallbackTitle;

  return {
    candidate: {
      recipe: {
        ...options.recipe,
        title,
        ingredients,
        steps,
        servings: tidy(payload.servings) || null,
        prepTimeMinutes: payload.prepTimeMinutes,
        cookTimeMinutes: payload.cookTimeMinutes,
        nutrition: null
      },
      strategy: "llm-fallback",
      evidence: ["Read the recipe from the video's speech, on-screen text and caption."],
      warnings:
        withoutAmounts.length > 0
          ? [`The video doesn't give amounts for: ${withoutAmounts.join(", ")}.`]
          : [],
      provenance: ["llm"],
      fieldProvenance: {
        title: "llm",
        ingredients: "llm",
        steps: "llm",
        servings: payload.servings ? "llm" : null,
        prepTimeMinutes: payload.prepTimeMinutes == null ? null : "llm",
        cookTimeMinutes: payload.cookTimeMinutes == null ? null : "llm",
        nutrition: null
      },
      signals: {
        requiredFieldsInferred: false,
        titleConfidence: payload.title ? "strong" : "weak",
        timesFromStructuredMetadata: false,
        recipeLike: true,
        detectionConfidence: "high",
        sectionCohesion: "medium",
        transcriptQuality: "strong",
        usedBrowserFallback: false,
        blockedSourceSignals: 0
      }
    },
    rejections
  };
};
