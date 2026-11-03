import { z } from "zod";

import {
  MAX_RECIPE_CONFIDENCE_NOTE_COUNT,
  MAX_RECIPE_INGREDIENT_COUNT,
  MAX_RECIPE_STEP_COUNT,
  recipeSchema,
  type Recipe
} from "../../../../../../packages/recipe-domain/src/index.js";
import { isItemNamedIn } from "../extractors/video/build-video-recipe-candidate.js";

/*
 * Fills the gaps in a recipe the person asked AI to complete: most often one read from a video
 * that shows the dish being made but never says how much of anything goes in. Gemini estimates
 * the amounts (and servings and times) from general cooking knowledge for the dish, and may make
 * the creator's steps more precise, but the recipe stays the creator's: every ingredient the
 * creator used must still be there, in the same order, and anything Gemini adds is marked as
 * added. An answer that drops one of the creator's ingredients is refused. The result says, in
 * its completion status and notes, that its amounts are AI estimates.
 */
export const DEFAULT_RECIPE_COMPLETION_MODEL = "gemini-3.8-flash";

export const AI_FILLED_NOTE =
  "AI estimated the amounts and filled in details the source didn't give. Check them before you cook.";

const completionPayloadSchema = z.object({
  ingredients: z
    .array(
      z.object({
        text: z.string().min(1),
        section: z.string().nullable().default(null),
        added: z.boolean().default(false)
      })
    )
    .min(1)
    .max(MAX_RECIPE_INGREDIENT_COUNT),
  steps: z
    .array(z.object({ text: z.string().min(1) }))
    .min(1)
    .max(MAX_RECIPE_STEP_COUNT),
  servings: z.string().nullable().default(null),
  prepTimeMinutes: z.number().int().nonnegative().max(10_080).nullable().default(null),
  cookTimeMinutes: z.number().int().nonnegative().max(10_080).nullable().default(null)
});

export type RecipeCompletionPayload = z.infer<typeof completionPayloadSchema>;

const completionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ingredients", "steps", "servings", "prepTimeMinutes", "cookTimeMinutes"],
  properties: {
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "section", "added"],
        properties: {
          text: {
            type: "string",
            description: "The ingredient with its amount, e.g. '2 cups shredded sharp cheddar'."
          },
          section: { type: ["string", "null"] },
          added: {
            type: "boolean",
            description: "True only for an ingredient the original list did not have."
          }
        }
      }
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } }
      }
    },
    servings: { type: ["string", "null"] },
    prepTimeMinutes: { type: ["integer", "null"], minimum: 0 },
    cookTimeMinutes: { type: ["integer", "null"], minimum: 0 }
  }
} as const;

/*
 * An amount a cook can use: a quantity ("2 cups", "½ tsp", "a pinch", "one can") or a measure
 * that is no number ("salt, to taste", "a handful of basil").
 */
const usableAmountPattern =
  /^\s*(?:\d|[½¼¾⅓⅔⅛⅜⅝⅞]|(?:a|an|one|two|three|four|five|six|half|a few|several)\s|(?:pinch|dash|splash|handful)\b)|\bto taste\b/iu;

export const hasUsableAmount = (text: string): boolean => usableAmountPattern.test(text);

/*
 * Whether this ingredient has no amount, so AI may give it one: the video reader listed it in
 * `completion.ingredients`, or its current text has no usable amount (the person may have edited
 * "broccoli" to "broccoli florets" since). Every other ingredient keeps its source text.
 */
const lacksAmount = (recipe: Recipe, text: string): boolean =>
  (recipe.completion?.status === "missing_amounts" &&
    recipe.completion.ingredients.includes(text)) ||
  !hasUsableAmount(text);

/* Preparation and size words AI may reword ("shredded" for "grated"); every other word stays. */
const rewordableWords = new Set([
  "and",
  "for",
  "the",
  "with",
  "fresh",
  "large",
  "small",
  "medium",
  "chopped",
  "diced",
  "minced",
  "sliced",
  "shredded",
  "grated",
  "crushed",
  "peeled",
  "optional",
  "taste",
  "divided",
  "softened",
  "melted",
  "cooked"
]);

const stemWord = (word: string): string =>
  word.length > 4 ? word.replace(/(?:es|s)$/u, "") : word;

const identityWords = (text: string): string[] =>
  (
    text
      .toLowerCase()
      .normalize("NFKD")
      .match(/\p{L}+/gu) ?? []
  )
    .filter((word) => word.length >= 3 && !rewordableWords.has(word))
    .map(stemWord);

/**
 * Whether `completed` is still the creator's ingredient: every word that names it ("cheddar"
 * and "cheese" in "cheddar cheese") is still there, so "cream cheese" or "whole milk" for
 * "almond milk" is a substitution, not the same ingredient with an amount.
 */
export const keepsIngredientIdentity = (original: string, completed: string): boolean => {
  const completedWords = new Set(identityWords(completed));
  const originalWords = identityWords(original);

  return originalWords.length > 0
    ? originalWords.every((word) => completedWords.has(word))
    : isItemNamedIn(original, completed);
};

export const buildRecipeCompletionPrompt = (recipe: Recipe): string =>
  [
    "This recipe was written down from a cooking video or post that shows how the dish is made but leaves out amounts and some details.",
    "Complete it so someone can cook it, using general cooking knowledge and typical recipes for this dish.",
    "Rules:",
    "- Keep every ingredient in the list, in the same order, and keep the creator's wording for the ingredient itself.",
    "- Give each ingredient listed under missingAmounts a realistic amount (e.g. '2 cups', '1 tbsp', '3 cloves'). Copy every other ingredient exactly as written: its amount came from the source.",
    "- Add an ingredient only when a step plainly needs it and the list lacks it (such as salt, oil or the stock a step pours in), mark it added, and put it where it is first used.",
    "- Keep the creator's steps and their order. Make each one precise enough to follow: amounts, heat level, times and temperatures where they matter. Add a step only when one is plainly missing (such as preheating the oven).",
    "- Give servings, prep time and cook time for the amounts you chose.",
    "- Do not change what the dish is or swap the creator's ingredients for others.",
    "- Return only JSON that matches the schema.",
    "",
    JSON.stringify({
      title: recipe.title,
      description: recipe.description ?? null,
      servings: recipe.servings,
      prepTimeMinutes: recipe.prepTimeMinutes,
      cookTimeMinutes: recipe.cookTimeMinutes,
      ingredients: recipe.ingredients.map((ingredient) => ({
        text: ingredient.text,
        section: ingredient.section ?? null
      })),
      missingAmounts: recipe.ingredients
        .filter((ingredient) => lacksAmount(recipe, ingredient.text))
        .map((ingredient) => ingredient.text),
      steps: recipe.steps.map((step) => step.text)
    })
  ].join("\n");

const tidy = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/gu, " ").trim();

/**
 * The completed recipe, or null when the answer drops, swaps or reorders one of the creator's
 * ingredients, leaves an ingredient that had no amount still without one, or does not make a
 * valid recipe. Null is a failed completion, so the person's allowance is given back.
 */
export const applyRecipeCompletion = (
  recipe: Recipe,
  payload: RecipeCompletionPayload,
  now: Date
): Recipe | null => {
  const kept = payload.ingredients.filter((ingredient) => !ingredient.added);

  /* The creator's ingredients, each still named, in their order. */
  if (kept.length !== recipe.ingredients.length) {
    return null;
  }

  for (let index = 0; index < kept.length; index += 1) {
    if (!keepsIngredientIdentity(recipe.ingredients[index]?.text ?? "", kept[index]?.text ?? "")) {
      return null;
    }
  }

  /* The point of the answer: every ingredient that had no amount now has one. */
  for (let index = 0; index < kept.length; index += 1) {
    const original = recipe.ingredients[index]?.text ?? "";

    if (lacksAmount(recipe, original) && !hasUsableAmount(kept[index]?.text ?? "")) {
      return null;
    }
  }

  /* An ingredient whose amount came from the source keeps its source text, whatever AI wrote. */
  let keptIndex = 0;
  const ingredients = payload.ingredients
    .map((ingredient) => {
      if (ingredient.added) {
        return { text: tidy(ingredient.text), section: tidy(ingredient.section) || null };
      }

      const original = recipe.ingredients[keptIndex];
      keptIndex += 1;

      return original && !lacksAmount(recipe, original.text)
        ? { text: original.text, section: original.section ?? null }
        : { text: tidy(ingredient.text), section: tidy(ingredient.section) || null };
    })
    .filter((ingredient) => ingredient.text.length > 0);
  const steps = payload.steps
    .map((step) => tidy(step.text))
    .filter((text) => text.length > 0)
    .map((text, index) => ({ index: index + 1, text }));
  const filledIngredients =
    recipe.completion?.status === "missing_amounts" && recipe.completion.ingredients.length > 0
      ? recipe.completion.ingredients
      : recipe.ingredients.map((ingredient) => ingredient.text);
  const notes = [
    ...recipe.confidence.notes.filter((note) => !/doesn't give amounts for/iu.test(note)),
    AI_FILLED_NOTE
  ].slice(-MAX_RECIPE_CONFIDENCE_NOTE_COUNT);

  const completed: Recipe = {
    ...recipe,
    ingredients,
    steps,
    servings: recipe.servings ?? (tidy(payload.servings) || null),
    prepTimeMinutes: recipe.prepTimeMinutes ?? payload.prepTimeMinutes,
    cookTimeMinutes: recipe.cookTimeMinutes ?? payload.cookTimeMinutes,
    confidence: {
      ...recipe.confidence,
      notes,
      missingFields: recipe.confidence.missingFields.filter(
        (field) =>
          !(field === "servings" && payload.servings) &&
          !(field === "prepTimeMinutes" && payload.prepTimeMinutes != null) &&
          !(field === "cookTimeMinutes" && payload.cookTimeMinutes != null)
      ),
      fieldProvenance: {
        ...recipe.confidence.fieldProvenance,
        ingredients: "llm",
        steps: "llm",
        servings: recipe.servings
          ? recipe.confidence.fieldProvenance.servings
          : payload.servings
            ? "llm"
            : null,
        prepTimeMinutes:
          recipe.prepTimeMinutes != null
            ? recipe.confidence.fieldProvenance.prepTimeMinutes
            : payload.prepTimeMinutes != null
              ? "llm"
              : null,
        cookTimeMinutes:
          recipe.cookTimeMinutes != null
            ? recipe.confidence.fieldProvenance.cookTimeMinutes
            : payload.cookTimeMinutes != null
              ? "llm"
              : null
      }
    },
    completion: { status: "ai_filled", ingredients: filledIngredients, filledAt: now.toISOString() }
  };

  const parsed = recipeSchema.safeParse(completed);
  return parsed.success ? parsed.data : null;
};

export interface RecipeCompleterOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RecipeCompleter {
  readonly available: boolean;
  readonly model: string | null;
  /** The completed recipe, or null when Gemini gave no usable answer. Throws only on cancel. */
  complete(recipe: Recipe, options?: RecipeCompleterOptions): Promise<Recipe | null>;
}

class GeminiRecipeCompleter implements RecipeCompleter {
  public readonly available = true;

  public constructor(
    private readonly apiKey: string,
    public readonly model: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly timeoutMs: number,
    private readonly now: () => Date
  ) {}

  public async complete(
    recipe: Recipe,
    options: RecipeCompleterOptions = {}
  ): Promise<Recipe | null> {
    const timeoutMs = Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs);

    if (timeoutMs <= 0 || options.signal?.aborted) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await this.fetchImplementation(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildRecipeCompletionPrompt(recipe) }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: completionJsonSchema
            }
          })
        }
      );

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      const parsed = text ? completionPayloadSchema.safeParse(JSON.parse(text) as unknown) : null;

      return parsed?.success ? applyRecipeCompletion(recipe, parsed.data, this.now()) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

class UnavailableRecipeCompleter implements RecipeCompleter {
  public readonly available = false;
  public readonly model = null;

  public complete(): Promise<Recipe | null> {
    return Promise.resolve(null);
  }
}

export const createGeminiRecipeCompleter = (options: {
  apiKey: string | undefined;
  model?: string | undefined;
  fetchImplementation: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}): RecipeCompleter =>
  options.apiKey
    ? new GeminiRecipeCompleter(
        options.apiKey,
        options.model?.trim() || DEFAULT_RECIPE_COMPLETION_MODEL,
        options.fetchImplementation,
        options.timeoutMs ?? 30_000,
        options.now ?? (() => new Date())
      )
    : new UnavailableRecipeCompleter();
