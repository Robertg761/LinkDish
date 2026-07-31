import { z } from "zod";

import { recipeSchema, type Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

import type { RecipeTextCleaner } from "../types.js";

export const GEMINI_TEXT_CLEANUP_MODEL = "gemini-3.1-flash-lite-preview";

const cleanedRecipePayloadSchema = z.object({
  title: z.string().min(1),
  ingredients: z.array(
    z.object({
      text: z.string().min(1),
      section: z.string().min(1).nullable()
    })
  ),
  steps: z.array(
    z.object({
      index: z.number().int().positive(),
      text: z.string().min(1)
    })
  ),
  servings: z.string().min(1).nullable(),
  nutrition: z
    .object({
      calories: z.string().min(1).nullable(),
      protein: z.string().min(1).nullable(),
      carbohydrates: z.string().min(1).nullable(),
      fat: z.string().min(1).nullable(),
      fiber: z.string().min(1).nullable(),
      sugar: z.string().min(1).nullable(),
      sodium: z.string().min(1).nullable()
    })
    .nullable()
});

type CleanedRecipePayload = z.infer<typeof cleanedRecipePayloadSchema>;

const cleanedRecipeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "ingredients", "steps", "servings", "nutrition"],
  properties: {
    title: { type: "string" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "section"],
        properties: {
          text: { type: "string" },
          section: { type: ["string", "null"] }
        }
      }
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "text"],
        properties: {
          index: { type: "integer", minimum: 1 },
          text: { type: "string" }
        }
      }
    },
    servings: { type: ["string", "null"] },
    nutrition: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["calories", "protein", "carbohydrates", "fat", "fiber", "sugar", "sodium"],
      properties: {
        calories: { type: ["string", "null"] },
        protein: { type: ["string", "null"] },
        carbohydrates: { type: ["string", "null"] },
        fat: { type: ["string", "null"] },
        fiber: { type: ["string", "null"] },
        sugar: { type: ["string", "null"] },
        sodium: { type: ["string", "null"] }
      }
    }
  }
} as const;

const toCleanupInput = (recipe: Recipe) => ({
  title: recipe.title,
  ingredients: recipe.ingredients.map((ingredient) => ({
    text: ingredient.text,
    section: ingredient.section ?? null
  })),
  steps: recipe.steps.map((step) => ({
    index: step.index,
    text: step.text
  })),
  servings: recipe.servings,
  nutrition: recipe.nutrition
});

const buildCleanupPrompt = (recipe: Recipe): string =>
  [
    "Clean only the user-visible text in this parsed recipe.",
    "Fix HTML artifacts, repeated whitespace, broken punctuation, leftover navigation labels, ad fragments, and obvious line-break glitches.",
    "Do not add, remove, reorder, or infer ingredients, steps, amounts, times, nutrition, servings, or method details.",
    "Keep the ingredient count, step count, step indexes, and ingredient sections aligned with the input.",
    "Return only JSON that matches the requested schema.",
    "",
    JSON.stringify(toCleanupInput(recipe))
  ].join("\n");

const normalizeNullableText = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const applyCleanedPayload = (recipe: Recipe, payload: CleanedRecipePayload): Recipe | null => {
  if (
    payload.ingredients.length !== recipe.ingredients.length ||
    payload.steps.length !== recipe.steps.length
  ) {
    return null;
  }

  for (let index = 0; index < payload.steps.length; index += 1) {
    if (payload.steps[index]?.index !== recipe.steps[index]?.index) {
      return null;
    }
  }

  const cleaned: Recipe = {
    ...recipe,
    title: payload.title.trim(),
    ingredients: recipe.ingredients.map((ingredient, index) => {
      const cleanedIngredient = payload.ingredients[index]!;

      return {
        ...ingredient,
        text: cleanedIngredient.text.trim(),
        section: normalizeNullableText(cleanedIngredient.section)
      };
    }),
    steps: recipe.steps.map((step, index) => ({
      ...step,
      text: payload.steps[index]!.text.trim()
    })),
    servings: normalizeNullableText(payload.servings),
    nutrition: payload.nutrition
      ? {
          calories: normalizeNullableText(payload.nutrition.calories),
          protein: normalizeNullableText(payload.nutrition.protein),
          carbohydrates: normalizeNullableText(payload.nutrition.carbohydrates),
          fat: normalizeNullableText(payload.nutrition.fat),
          fiber: normalizeNullableText(payload.nutrition.fiber),
          sugar: normalizeNullableText(payload.nutrition.sugar),
          sodium: normalizeNullableText(payload.nutrition.sodium)
        }
      : null
  };

  const parsed = recipeSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : null;
};

class AvailableGeminiRecipeTextCleaner implements RecipeTextCleaner {
  public readonly available = true;
  public readonly providerName = "gemini" as const;

  public constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly timeoutMs: number
  ) {}

  public async clean(recipe: Recipe): Promise<Recipe> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    const generationConfig = {
      ...(this.model.startsWith("gemini-3") ? {} : { temperature: 0 }),
      responseMimeType: "application/json",
      responseJsonSchema: cleanedRecipeJsonSchema
    };

    try {
      const response = await this.fetchImplementation(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: buildCleanupPrompt(recipe)
                  }
                ]
              }
            ],
            generationConfig
          })
        }
      );

      if (!response.ok) {
        return recipe;
      }

      const body = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
            }>;
          };
        }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        return recipe;
      }

      const parsed = cleanedRecipePayloadSchema.safeParse(JSON.parse(text) as unknown);

      if (!parsed.success) {
        return recipe;
      }

      return applyCleanedPayload(recipe, parsed.data) ?? recipe;
    } catch {
      return recipe;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

class UnavailableRecipeTextCleaner implements RecipeTextCleaner {
  public readonly available = false;
  public readonly providerName = "none" as const;

  public clean(recipe: Recipe): Promise<Recipe> {
    return Promise.resolve(recipe);
  }
}

export const createGeminiRecipeTextCleaner = (options: {
  apiKey: string | undefined;
  model: string | undefined;
  fetchImplementation: typeof fetch;
  timeoutMs?: number;
}): RecipeTextCleaner =>
  options.apiKey
    ? new AvailableGeminiRecipeTextCleaner(
        options.apiKey,
        options.model?.trim() || GEMINI_TEXT_CLEANUP_MODEL,
        options.fetchImplementation,
        options.timeoutMs ?? 8_000
      )
    : new UnavailableRecipeTextCleaner();
