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

/* Spoken whole numbers: "twenty five" and "two hundred" are read as one number. */
const unitWords: Record<string, number> = {
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
};
const tensWords: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
};
const scaleWords: Record<string, number> = { dozen: 12, hundred: 100, thousand: 1000 };
const fractionWords: Record<string, number> = {
  half: 0.5,
  halves: 0.5,
  third: 1 / 3,
  thirds: 1 / 3,
  quarter: 0.25,
  quarters: 0.25
};
const articles = new Set(["a", "an"]);
/* "a heaping cup", "a large egg": one of these may sit between an article and what it counts. */
const sizeWords = new Set([
  "heaping",
  "heaped",
  "level",
  "big",
  "large",
  "small",
  "medium",
  "generous",
  "good",
  "full",
  "whole"
]);

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
const amountFillerWords = new Set([
  "a",
  "an",
  "of",
  "or",
  "to",
  "the",
  "and",
  "about",
  "around",
  "roughly"
]);

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

/*
 * The forms a word can take in the singular, so "tomatoes" matches "tomato", "spices" "spice"
 * and "berries" "berry": two words match when they share a form.
 */
const singularForms = (word: string): string[] => {
  const forms = [word];

  if (word.endsWith("ies")) {
    forms.push(`${word.slice(0, -3)}y`);
  }

  if (word.endsWith("es")) {
    forms.push(word.slice(0, -2));
  }

  if (word.endsWith("s") && !word.endsWith("ss")) {
    forms.push(word.slice(0, -1));
  }

  return forms;
};

const wordsOf = (value: string): string[] => normalize(value).match(/\p{L}+/gu) ?? [];

const formsOf = (value: string): Set<string> => new Set(wordsOf(value).flatMap(singularForms));

const sharesForm = (word: string, forms: Set<string>): boolean =>
  singularForms(word).some((form) => forms.has(form));

/* A caption quote is held to the caption's own words, whatever its punctuation or emoji. */
const wordSequence = (value: string): string =>
  ` ${(normalize(value).match(/\d+(?:[.,/]\d+)*|\p{L}+/gu) ?? []).join(" ")} `;

const isQuotedFrom = (quote: string, text: string): boolean => {
  const quoted = wordSequence(quote);
  return quoted.trim().length > 0 && wordSequence(text).includes(quoted);
};

const tokensOf = (value: string): string[] =>
  normalize(value).match(/\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|\p{L}+/gu) ?? [];

/* A number a text states, with the tokens it spans: "two hundred" is one, from 0 to 2. */
interface StatedNumber {
  value: number;
  fraction: boolean;
  start: number;
  end: number;
}

/* A run of spoken whole-number words from tokens[start]: "two hundred and fifty" is 250. */
const readSpokenWhole = (
  tokens: string[],
  start: number
): { value: number; end: number } | null => {
  let total = 0;
  let current = 0;
  let last: "unit" | "tens" | "scale" | null = null;
  let index = start;

  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";

    if (Object.hasOwn(unitWords, token) && last !== "unit") {
      const value = unitWords[token] ?? 0;

      /* "twenty five", not "twenty twelve". */
      if (last === "tens" && value >= 10) {
        break;
      }

      current += value;
      last = "unit";
    } else if (Object.hasOwn(tensWords, token) && last !== "unit" && last !== "tens") {
      current += tensWords[token] ?? 0;
      last = "tens";
    } else if (Object.hasOwn(scaleWords, token)) {
      const scale = scaleWords[token] ?? 1;

      if (scale === 1000) {
        total += (current || 1) * scale;
        current = 0;
      } else {
        current = (current || 1) * scale;
      }

      last = "scale";
    } else if (
      token === "and" &&
      last === "scale" &&
      (Object.hasOwn(unitWords, next) || Object.hasOwn(tensWords, next))
    ) {
      continue;
    } else {
      break;
    }
  }

  return index === start ? null : { value: total + current, end: index };
};

/*
 * Every number a text states, in order: digits, fractions, number words and fraction words. "A"
 * and "an" state 1 only before what they count, a unit ("a cup") or the ingredient ("an egg"),
 * and nothing at all in "half a cup".
 */
const readNumbers = (tokens: string[], articleCounts: Set<string> | null): StatedNumber[] => {
  const numbers: StatedNumber[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const next = tokens[index + 1] ?? "";
    const push = (value: number, end: number) => {
      if (Number.isFinite(value)) {
        numbers.push({ value, fraction: value < 1, start: index, end });
      }

      index = end;
    };

    if (/^\d+\s*\/\s*\d+$/u.test(token)) {
      const [numerator = 0, denominator = 0] = token.split("/").map((part) => Number(part.trim()));
      push(denominator ? numerator / denominator : Number.NaN, index + 1);
      continue;
    }

    if (/^\d/u.test(token)) {
      push(Number(token.replace(",", ".")), index + 1);
      continue;
    }

    if (Object.hasOwn(fractionWords, token)) {
      push(fractionWords[token] ?? Number.NaN, index + 1);
      continue;
    }

    const spoken = readSpokenWhole(tokens, index);

    if (spoken) {
      push(spoken.value, spoken.end);
      continue;
    }

    if (articles.has(token) && !Object.hasOwn(fractionWords, tokens[index - 1] ?? "")) {
      /* "a half", "a dozen", "a couple": the article is part of the number. */
      if (Object.hasOwn(fractionWords, next)) {
        push(fractionWords[next] ?? Number.NaN, index + 2);
        continue;
      }

      const spokenNext =
        next === "couple" || Object.hasOwn(scaleWords, next)
          ? readSpokenWhole(tokens, index + 1)
          : null;

      if (spokenNext) {
        push(spokenNext.value, spokenNext.end);
        continue;
      }

      const counted = sizeWords.has(next) ? (tokens[index + 2] ?? "") : next;

      if (articleCounts && (unitFamilyOf.has(counted) || sharesForm(counted, articleCounts))) {
        push(1, index + 1);
        continue;
      }
    }

    index += 1;
  }

  return numbers;
};

/*
 * The amounts a text states. "Three quarters" is one amount, the product, and a mixed number
 * ("1 1/2", "one and a half", "a cup and a half") is one, the sum of its parts.
 */
const readQuantities = (
  value: string,
  articleCounts: Set<string> | null
): { quantity: number; parts: number[] }[] => {
  const tokens = tokensOf(value);
  const terms: StatedNumber[] = [];

  for (const number of readNumbers(tokens, articleCounts)) {
    const last = terms.at(-1);
    const isBareFractionWord =
      number.end - number.start === 1 && Object.hasOwn(fractionWords, tokens[number.start] ?? "");

    if (last && !last.fraction && last.end === number.start && isBareFractionWord) {
      terms[terms.length - 1] = {
        value: last.value * number.value,
        fraction: last.value * number.value < 1,
        start: last.start,
        end: number.end
      };
    } else {
      terms.push(number);
    }
  }

  const quantities: { quantity: number; parts: number[]; end: number }[] = [];

  for (const term of terms) {
    const last = quantities.at(-1);
    const between = last ? tokens.slice(last.end, term.start) : [];
    const joined =
      between.length === 0 ||
      (between.length === 1 && between[0] === "and") ||
      (between.length === 2 && unitFamilyOf.has(between[0] ?? "") && between[1] === "and");

    /* Not "1/2 1/2" or "2 3". */
    if (last && last.parts.length === 1 && last.quantity >= 1 && term.fraction && joined) {
      last.parts.push(term.value);
      last.quantity += term.value;
      last.end = term.end;
    } else {
      quantities.push({ quantity: term.value, parts: [term.value], end: term.end });
    }
  }

  return quantities.map(({ quantity, parts }) => ({ quantity, parts }));
};

/** Every number a text states, mixed numbers both whole and as their parts. */
export const readStatedNumbers = (value: string, item = ""): number[] =>
  readQuantities(value, formsOf(item)).flatMap(({ quantity, parts }) =>
    parts.length > 1 ? [quantity, ...parts] : [quantity]
  );

const sameNumber = (left: number, right: number): boolean => Math.abs(left - right) < 0.01;

/*
 * Does the quote state the amount: each of its numbers, or for "a pinch" its own words. The item
 * lets "an egg" in the quote state 1.
 */
export const isAmountSupported = (amount: string, quote: string, item = ""): boolean => {
  /* "a pinch" and "a cup" have no number of their own; "a cup" in the quote still states 1 cup. */
  const amountQuantities = readQuantities(amount, null).map(({ quantity }) => quantity);
  const quoteUnits = new Set(wordsOf(quote).map((word) => unitFamilyOf.get(word)));
  const amountUnits = wordsOf(amount)
    .map((word) => unitFamilyOf.get(word))
    .filter((unit) => unit !== undefined);

  if (amountQuantities.length > 0) {
    const stated = readStatedNumbers(quote, item);

    return (
      amountQuantities.every((value) => stated.some((number) => sameNumber(number, value))) &&
      amountUnits.every((unit) => quoteUnits.has(unit))
    );
  }

  /*
   * "a tablespoon", "a pinch": one of the unit. The quote must say that unit, and must not state
   * it as another amount, so "a teaspoon of salt" and "half a cup" do not support them.
   */
  if (amountUnits.length > 0) {
    const stated = readStatedNumbers(quote, item);

    return (
      amountUnits.every((unit) => quoteUnits.has(unit)) &&
      (stated.length === 0 || stated.some((number) => sameNumber(number, 1)))
    );
  }

  const quoteForms = formsOf(quote);
  const amountWords = wordsOf(amount).filter((word) => !amountFillerWords.has(word));

  return amountWords.length > 0 && amountWords.some((word) => sharesForm(word, quoteForms));
};

/* Does the quote name the ingredient: one of its meaningful words, singular or plural. */
export const isItemNamedIn = (item: string, quote: string): boolean => {
  const quoteForms = formsOf(quote);
  const itemWords = wordsOf(item).filter((word) => word.length >= 3 && !nameStopWords.has(word));
  const candidates = itemWords.length > 0 ? itemWords : wordsOf(item);

  return candidates.some((word) => sharesForm(word, quoteForms));
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

    /*
     * A caption quote must be a line of the caption, and is then held to the same checks as a
     * spoken or on-screen one: the quote, not the whole caption, must name the item and state
     * the amount.
     */
    if (ingredient.source === "caption" && !isQuotedFrom(quote, caption)) {
      rejections.push(`caption quote not in the caption: ${item} <- "${quote}"`);
      continue;
    }

    if (ingredient.source !== "visual" && !isItemNamedIn(item, quote)) {
      rejections.push(`ingredient not in its quote: ${item} <- "${quote}"`);
      continue;
    }

    let amount = tidy(ingredient.amount);

    if (amount && ingredient.source === "visual") {
      rejections.push(`amount for an ingredient only shown: ${amount} ${item}`);
      amount = "";
    } else if (amount && !isAmountSupported(amount, quote, item)) {
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
