import { z } from "zod";

export * from "./samples.js";
export * from "./cook-timers.js";
export * from "./ingredient-quantities.js";
export * from "./step-ingredients.js";
export * from "./shopping.js";

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

export const recipeIngredientSchema = z.object({
  text: z.string().min(1),
  section: z.string().min(1).nullable().optional()
});

export const recipeStepSchema = z.object({
  index: z.number().int().positive(),
  text: z.string().min(1)
});

export const recipeConfidenceSchema = z.object({
  score: z.number().min(0).max(1),
  summary: z.string().min(1),
  missingFields: z.array(missingRecipeFieldSchema),
  notes: z.array(z.string().min(1)).default([]),
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

export const recipeNutritionSchema = z.object({
  calories: z.string().min(1).nullable(),
  protein: z.string().min(1).nullable(),
  carbohydrates: z.string().min(1).nullable(),
  fat: z.string().min(1).nullable(),
  fiber: z.string().min(1).nullable(),
  sugar: z.string().min(1).nullable(),
  sodium: z.string().min(1).nullable()
});

export const recipeImageSourceSchema = z.enum([
  "jsonld",
  "og",
  "twitter",
  "content",
  "youtube-thumb"
]);

export const recipeImageSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  source: recipeImageSourceSchema
});

const recipeSchemaBase = z.object({
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceType: sourceTypeSchema,
  image: recipeImageSchema.nullable().optional().default(null),
  ingredients: z.array(recipeIngredientSchema),
  steps: z.array(recipeStepSchema),
  servings: z.string().nullable(),
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
