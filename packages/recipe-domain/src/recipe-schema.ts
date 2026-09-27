import { z } from "zod";

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
export const MAX_RECIPE_DESCRIPTION_LENGTH = 5_000;
export const MAX_RECIPE_AUTHOR_LENGTH = 200;
export const MAX_RECIPE_SITE_NAME_LENGTH = 200;
export const MAX_RECIPE_CUISINE_LENGTH = 100;
export const MAX_RECIPE_CATEGORY_LENGTH = 100;
export const MAX_RECIPE_KEYWORD_COUNT = 30;
export const MAX_RECIPE_KEYWORD_LENGTH = 60;
/** A week. Longer "total times" are data-entry noise (a year of "curing" typed in minutes). */
export const MAX_RECIPE_TOTAL_TIME_MINUTES = 7 * 24 * 60;

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

const HIGH_SURROGATE_PATTERN = /[\uD800-\uDBFF]$/u;

/** Cuts text to `maxLength` UTF-16 units without leaving half of a surrogate pair behind. */
const clipText = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength).replace(HIGH_SURROGATE_PATTERN, "").trimEnd();
};

const WHITESPACE_RUN_PATTERN = /\s+/gu;

/**
 * Normalizes optional free-text metadata (description, author, cuisine...). These fields come from
 * third-party JSON-LD, so a blank value becomes null and an oversized one is clipped instead of
 * failing the whole recipe: losing the tail of a 6,000 character description is better than
 * losing the import.
 */
const normalizeOptionalText =
  (maxLength: number, collapseWhitespace: boolean) =>
  (value: unknown): unknown => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = (
      collapseWhitespace ? value.replace(WHITESPACE_RUN_PATTERN, " ") : value
    ).trim();
    return trimmed.length === 0 ? null : clipText(trimmed, maxLength);
  };

const optionalRecipeTextSchema = (maxLength: number, collapseWhitespace = true) =>
  z.preprocess(
    normalizeOptionalText(maxLength, collapseWhitespace),
    z.string().min(1).max(maxLength).nullable().optional()
  );

const KEYWORD_SEPARATOR_PATTERN = /[,;\n]/u;

/**
 * schema.org `keywords` arrives either as an array or as one comma-separated string. Both
 * become a de-duplicated (case-insensitive) list of at most 30 keywords of at most 60
 * characters; non-string entries are dropped.
 */
const normalizeKeywords = (value: unknown): unknown => {
  if (typeof value !== "string" && !Array.isArray(value)) {
    return value;
  }

  const rawEntries: readonly unknown[] =
    typeof value === "string" ? value.split(KEYWORD_SEPARATOR_PATTERN) : value;

  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const entry of rawEntries) {
    if (typeof entry !== "string") {
      continue;
    }

    const keyword = clipText(
      entry.replace(WHITESPACE_RUN_PATTERN, " ").trim(),
      MAX_RECIPE_KEYWORD_LENGTH
    );
    const key = keyword.toLowerCase();

    if (keyword.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    keywords.push(keyword);

    if (keywords.length >= MAX_RECIPE_KEYWORD_COUNT) {
      break;
    }
  }

  return keywords;
};

const blankToNull = (value: unknown): unknown =>
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
  confidence: recipeConfidenceSchema,
  // Optional metadata (additive; records saved before these existed parse unchanged).
  description: optionalRecipeTextSchema(MAX_RECIPE_DESCRIPTION_LENGTH, false),
  totalTimeMinutes: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_RECIPE_TOTAL_TIME_MINUTES)
    .nullable()
    .optional(),
  author: optionalRecipeTextSchema(MAX_RECIPE_AUTHOR_LENGTH),
  siteName: optionalRecipeTextSchema(MAX_RECIPE_SITE_NAME_LENGTH),
  cuisine: optionalRecipeTextSchema(MAX_RECIPE_CUISINE_LENGTH),
  category: optionalRecipeTextSchema(MAX_RECIPE_CATEGORY_LENGTH),
  keywords: z.preprocess(
    normalizeKeywords,
    z
      .array(z.string().min(1).max(MAX_RECIPE_KEYWORD_LENGTH))
      .max(MAX_RECIPE_KEYWORD_COUNT)
      .nullable()
      .optional()
  ),
  videoUrl: z.preprocess(blankToNull, httpUrlSchema.nullable().optional())
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
/**
 * The recipe contract. Typed as `ZodType<Recipe>` so the public `Recipe` type keeps its
 * optional `image`; use `recipeObjectSchema` when you need `.shape`, `.pick` or `.extend`.
 */
export const recipeSchema: z.ZodType<Recipe, z.ZodTypeDef, unknown> = recipeSchemaBase;
/** The same schema as `recipeSchema`, exposed as the underlying `ZodObject`. */
export const recipeObjectSchema = recipeSchemaBase;
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
