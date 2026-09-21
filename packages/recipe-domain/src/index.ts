import { z } from "zod";

export * from "./samples.js";
export * from "./cook-timers.js";
export * from "./ingredient-quantities.js";
export * from "./step-ingredients.js";
export * from "./shopping.js";

const MAX_URL_LENGTH = 2_048;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * `z.string().url()` only checks that `new URL()` accepts the value, so `javascript:`, `data:`,
 * `file:` and `vbscript:` URLs all pass it, as do credential-bearing URLs such as
 * `http://user:pass@evil.com@good.com/`. Every URL that crosses a LinkDish contract goes through
 * this schema instead.
 */
export const isHttpUrl = (value: string): boolean => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }

  return parsed.hostname.length > 0;
};

export const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine(isHttpUrl, "Only http(s) URLs without embedded credentials are allowed.");

/** Builds an `httpUrlSchema` that is additionally pinned to a set of hosts (and their subdomains). */
export const buildPinnedHttpUrlSchema = (
  allowedHosts: readonly string[],
  message: string
): z.ZodType<string, z.ZodTypeDef, unknown> =>
  httpUrlSchema.refine((value) => {
    const { hostname } = new URL(value);
    const normalizedHostname = hostname.toLowerCase();

    return allowedHosts.some(
      (host) => normalizedHostname === host || normalizedHostname.endsWith(`.${host}`)
    );
  }, message);

export const sourceTypeSchema = z.enum([
  "recipe-webpage",
  "article",
  "youtube",
  "image",
  "video",
  "social",
  "unknown"
]);

export type SourceType = z.infer<typeof sourceTypeSchema>;

export const missingRecipeFieldSchema = z.enum([
  "ingredients",
  "steps",
  "servings",
  "prepTimeMinutes",
  "cookTimeMinutes"
]);

export type MissingRecipeField = z.infer<typeof missingRecipeFieldSchema>;

export const MAX_RECIPE_TITLE_LENGTH = 300;
export const MAX_RECIPE_INGREDIENT_TEXT_LENGTH = 2_000;
export const MAX_RECIPE_INGREDIENT_SECTION_LENGTH = 200;
export const MAX_RECIPE_INGREDIENT_COUNT = 300;
export const MAX_RECIPE_STEP_TEXT_LENGTH = 10_000;
export const MAX_RECIPE_STEP_COUNT = 300;
export const MAX_RECIPE_STEP_INDEX = 10_000;
export const MAX_RECIPE_SERVINGS_LENGTH = 200;
export const MAX_RECIPE_NUTRITION_VALUE_LENGTH = 200;
export const MAX_RECIPE_CONFIDENCE_SUMMARY_LENGTH = 4_000;
export const MAX_RECIPE_CONFIDENCE_NOTE_LENGTH = 2_000;
export const MAX_RECIPE_CONFIDENCE_NOTE_COUNT = 100;

export const recipeIngredientSchema = z.object({
  text: z.string().min(1).max(MAX_RECIPE_INGREDIENT_TEXT_LENGTH),
  section: z.string().min(1).max(MAX_RECIPE_INGREDIENT_SECTION_LENGTH).nullable().optional()
});

export const recipeStepSchema = z.object({
  index: z.number().int().positive().max(MAX_RECIPE_STEP_INDEX),
  text: z.string().min(1).max(MAX_RECIPE_STEP_TEXT_LENGTH)
});

export const recipeConfidenceSchema = z.object({
  score: z.number().min(0).max(1),
  summary: z.string().min(1).max(MAX_RECIPE_CONFIDENCE_SUMMARY_LENGTH),
  missingFields: z.array(missingRecipeFieldSchema),
  notes: z
    .array(z.string().min(1).max(MAX_RECIPE_CONFIDENCE_NOTE_LENGTH))
    .max(MAX_RECIPE_CONFIDENCE_NOTE_COUNT)
    .default([]),
  fieldProvenance: z.object({
    title: z.enum(["jsonld", "microdata", "visible-text", "llm"]),
    ingredients: z.enum(["jsonld", "microdata", "visible-text", "transcript", "llm"]),
    steps: z.enum(["jsonld", "microdata", "visible-text", "transcript", "llm"]),
    servings: z.enum(["jsonld", "microdata", "visible-text", "llm"]).nullable(),
    prepTimeMinutes: z.enum(["jsonld", "microdata", "visible-text", "llm"]).nullable(),
    cookTimeMinutes: z.enum(["jsonld", "microdata", "visible-text", "llm"]).nullable(),
    nutrition: z.enum(["jsonld", "microdata", "visible-text", "llm"]).nullable()
  })
});

const recipeNutritionValueSchema = z
  .string()
  .min(1)
  .max(MAX_RECIPE_NUTRITION_VALUE_LENGTH)
  .nullable();

export const recipeNutritionSchema = z.object({
  calories: recipeNutritionValueSchema,
  protein: recipeNutritionValueSchema,
  carbohydrates: recipeNutritionValueSchema,
  fat: recipeNutritionValueSchema,
  fiber: recipeNutritionValueSchema,
  sugar: recipeNutritionValueSchema,
  sodium: recipeNutritionValueSchema
});

export const recipeImageSourceSchema = z.enum([
  "jsonld",
  "og",
  "twitter",
  "content",
  "youtube-thumb"
]);

export const recipeImageSchema = z.object({
  url: httpUrlSchema,
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  source: recipeImageSourceSchema
});

const blankServingsToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? null : value;

const hasUniqueStepIndices = (steps: readonly { index: number }[]): boolean =>
  new Set(steps.map((step) => step.index)).size === steps.length;

const recipeSchemaBase = z.object({
  title: z.string().min(1).max(MAX_RECIPE_TITLE_LENGTH),
  sourceUrl: httpUrlSchema,
  sourceType: sourceTypeSchema,
  image: recipeImageSchema.nullable().optional().default(null),
  ingredients: z.array(recipeIngredientSchema).min(1).max(MAX_RECIPE_INGREDIENT_COUNT),
  steps: z
    .array(recipeStepSchema)
    .min(1)
    .max(MAX_RECIPE_STEP_COUNT)
    .refine(hasUniqueStepIndices, "Recipe step indices must be unique."),
  servings: z.preprocess(
    blankServingsToNull,
    z.string().min(1).max(MAX_RECIPE_SERVINGS_LENGTH).nullable()
  ),
  prepTimeMinutes: z.number().int().nonnegative().nullable(),
  cookTimeMinutes: z.number().int().nonnegative().nullable(),
  nutrition: recipeNutritionSchema.nullable(),
  confidence: recipeConfidenceSchema
});

export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;
export type RecipeStep = z.infer<typeof recipeStepSchema>;
export type RecipeConfidence = z.infer<typeof recipeConfidenceSchema>;
export type RecipeNutrition = z.infer<typeof recipeNutritionSchema>;
export type RecipeImageSource = z.infer<typeof recipeImageSourceSchema>;
export type RecipeImage = z.infer<typeof recipeImageSchema>;
type RecipeSchemaOutput = z.infer<typeof recipeSchemaBase>;
export type Recipe = Omit<RecipeSchemaOutput, "image"> & {
  image?: RecipeImage | null;
};
export const recipeSchema: z.ZodType<Recipe, z.ZodTypeDef, unknown> = recipeSchemaBase;
export type RecipeFieldProvenance = z.infer<typeof recipeConfidenceSchema.shape.fieldProvenance>;
export type RequiredRecipeField = "title" | "ingredients" | "steps";

export const requiredRecipeFields = [
  "title",
  "ingredients",
  "steps"
] as const satisfies readonly RequiredRecipeField[];

export const computeMissingRecipeFields = (recipe: {
  ingredients?: RecipeIngredient[];
  steps?: RecipeStep[];
  servings?: string | null;
  prepTimeMinutes?: number | null;
  cookTimeMinutes?: number | null;
}): MissingRecipeField[] => {
  const missingFields: MissingRecipeField[] = [];

  if (!recipe.ingredients || recipe.ingredients.length === 0) {
    missingFields.push("ingredients");
  }

  if (!recipe.steps || recipe.steps.length === 0) {
    missingFields.push("steps");
  }

  if (!recipe.servings) {
    missingFields.push("servings");
  }

  if (recipe.prepTimeMinutes == null) {
    missingFields.push("prepTimeMinutes");
  }

  if (recipe.cookTimeMinutes == null) {
    missingFields.push("cookTimeMinutes");
  }

  return missingFields;
};

export const hasRequiredRecipeFields = (recipe: Partial<Recipe>): boolean =>
  typeof recipe.title === "string" &&
  recipe.title.trim().length > 0 &&
  Array.isArray(recipe.ingredients) &&
  recipe.ingredients.length > 0 &&
  Array.isArray(recipe.steps) &&
  recipe.steps.length > 0;

export const buildMissingFieldSummary = (recipe: Partial<Recipe>): string => {
  const requiredIssues: string[] = [];

  if (typeof recipe.title !== "string" || recipe.title.trim().length === 0) {
    requiredIssues.push("title");
  }

  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    requiredIssues.push("ingredients");
  }

  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    requiredIssues.push("steps");
  }

  const optionalIssues = computeMissingRecipeFields(recipe)
    .filter((field) => !requiredIssues.includes(field))
    .join(", ");

  if (requiredIssues.length === 0 && optionalIssues.length === 0) {
    return "No missing recipe fields.";
  }

  if (requiredIssues.length === 0) {
    return `Missing optional fields: ${optionalIssues}.`;
  }

  if (optionalIssues.length === 0) {
    return `Missing required fields: ${requiredIssues.join(", ")}.`;
  }

  return `Missing required fields: ${requiredIssues.join(", ")}. Missing optional fields: ${optionalIssues}.`;
};
