/**
 * The versioned LinkDish backup format: every saved recipe with its personal metadata
 * (favorite, tags, rating, notes, cook log), plus optional collections and meal plan. Export
 * writes it as JSON; import validates it tolerantly so one damaged recipe does not sink a
 * whole library restore.
 */
import { z } from "zod";

import { mealPlanEntrySchema } from "./meal-plan-schema.js";
import { httpUrlSchema, recipeSchema } from "./recipe-schema.js";

import type { MealPlanEntry } from "./meal-plan-schema.js";
import type { Recipe } from "./recipe-schema.js";

export const LINKDISH_BACKUP_FORMAT = "linkdish-backup";
export const LINKDISH_BACKUP_VERSION = 1;
export const MAX_BACKUP_RECIPES = 10_000;
export const MAX_BACKUP_COLLECTIONS = 500;
export const MAX_BACKUP_MEAL_PLAN_ENTRIES = 10_000;
export const MAX_BACKUP_TAGS = 50;
export const MAX_BACKUP_TAG_LENGTH = 60;
export const MAX_BACKUP_NOTES_LENGTH = 20_000;
export const MAX_BACKUP_COOK_LOG_ENTRIES = 1_000;

export const backupCookLogEntrySchema = z.object({
  cookedAt: z.string().datetime(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  note: z.string().max(2_000).nullable().optional()
});

export const backupRecipeMetaSchema = z.object({
  favorite: z.boolean().optional(),
  tags: z
    .array(z.string().trim().min(1).max(MAX_BACKUP_TAG_LENGTH))
    .max(MAX_BACKUP_TAGS)
    .optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(MAX_BACKUP_NOTES_LENGTH).nullable().optional(),
  timesCooked: z.number().int().nonnegative().max(100_000).optional(),
  cookLog: z.array(backupCookLogEntrySchema).max(MAX_BACKUP_COOK_LOG_ENTRIES).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sourceUrl: httpUrlSchema
});

export const backupRecipeSchema = z.object({
  /** The app's own id for the saved recipe, when it has one. */
  id: z.string().trim().min(1).max(180).optional(),
  recipe: recipeSchema,
  meta: backupRecipeMetaSchema
});

export const backupCollectionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  recipeIds: z.array(z.string().trim().min(1).max(180)).max(MAX_BACKUP_RECIPES),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

export const linkdishBackupSchema = z.object({
  format: z.literal(LINKDISH_BACKUP_FORMAT),
  version: z.literal(LINKDISH_BACKUP_VERSION),
  exportedAt: z.string().datetime(),
  /** Free-form producer label ("web 2.4.0"). */
  app: z.string().trim().min(1).max(60).optional(),
  recipes: z.array(backupRecipeSchema).max(MAX_BACKUP_RECIPES),
  collections: z.array(backupCollectionSchema).max(MAX_BACKUP_COLLECTIONS).optional(),
  mealPlan: z.array(mealPlanEntrySchema).max(MAX_BACKUP_MEAL_PLAN_ENTRIES).optional()
});

export type BackupCookLogEntry = z.infer<typeof backupCookLogEntrySchema>;
export type BackupRecipeMeta = z.infer<typeof backupRecipeMetaSchema>;
export type BackupRecipe = Omit<z.infer<typeof backupRecipeSchema>, "recipe"> & { recipe: Recipe };
export type BackupCollection = z.infer<typeof backupCollectionSchema>;
export type LinkDishBackup = Omit<z.infer<typeof linkdishBackupSchema>, "recipes"> & {
  recipes: BackupRecipe[];
};

export type BackupValidationResult =
  | {
      ok: true;
      backup: LinkDishBackup;
      /** Parts that were skipped ("Recipe 3 ("Soup") was skipped: …"). */
      warnings: string[];
    }
  | { ok: false; error: string; warnings: string[] };

/** The envelope, checked before any recipe so a wrong file fails fast with a clear message. */
const envelopeSchema = z.object({
  format: z.string(),
  version: z.number(),
  exportedAt: z.string().datetime(),
  app: z.string().trim().min(1).max(60).optional(),
  recipes: z.array(z.unknown()).max(MAX_BACKUP_RECIPES),
  collections: z.array(z.unknown()).max(MAX_BACKUP_COLLECTIONS).optional(),
  mealPlan: z.array(z.unknown()).max(MAX_BACKUP_MEAL_PLAN_ENTRIES).optional()
});

const describeIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];

  if (!issue) {
    return "invalid data";
  }

  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
};

const titleOf = (value: unknown): string => {
  if (typeof value === "object" && value !== null) {
    const recipe = (value as { recipe?: { title?: unknown } }).recipe;

    if (recipe && typeof recipe.title === "string") {
      return ` ("${recipe.title.slice(0, 60)}")`;
    }
  }

  return "";
};

/**
 * Validates a LinkDish backup (an object, or its JSON text). The envelope must be right — the
 * format name, a version this build understands, arrays within bounds — or the whole file is
 * rejected. Inside it, each recipe, collection and meal-plan entry is checked on its own:
 * invalid ones are skipped with a warning instead of failing the restore.
 */
export const validateBackup = (input: unknown): BackupValidationResult => {
  let value = input;

  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, error: "This file is not valid JSON.", warnings: [] };
    }
  }

  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "This is not a LinkDish backup.", warnings: [] };
  }

  const format = (value as { format?: unknown }).format;
  const version = (value as { version?: unknown }).version;

  if (format !== LINKDISH_BACKUP_FORMAT) {
    return { ok: false, error: "This is not a LinkDish backup.", warnings: [] };
  }

  if (typeof version === "number" && version > LINKDISH_BACKUP_VERSION) {
    return {
      ok: false,
      error: "This backup was made by a newer version of LinkDish. Update the app to restore it.",
      warnings: []
    };
  }

  const envelope = envelopeSchema.safeParse(value);

  if (!envelope.success || envelope.data.version !== LINKDISH_BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup is damaged (${envelope.success ? "unknown version" : describeIssue(envelope.error)}).`,
      warnings: []
    };
  }

  const warnings: string[] = [];
  const recipes: BackupRecipe[] = [];

  envelope.data.recipes.forEach((entry, index) => {
    const parsed = backupRecipeSchema.safeParse(entry);

    if (parsed.success) {
      recipes.push(parsed.data as BackupRecipe);
    } else {
      warnings.push(
        `Recipe ${index + 1}${titleOf(entry)} was skipped: ${describeIssue(parsed.error)}`
      );
    }
  });

  const collections: BackupCollection[] = [];
  envelope.data.collections?.forEach((entry, index) => {
    const parsed = backupCollectionSchema.safeParse(entry);

    if (parsed.success) {
      collections.push(parsed.data);
    } else {
      warnings.push(`Collection ${index + 1} was skipped: ${describeIssue(parsed.error)}`);
    }
  });

  const mealPlan: MealPlanEntry[] = [];
  envelope.data.mealPlan?.forEach((entry, index) => {
    const parsed = mealPlanEntrySchema.safeParse(entry);

    if (parsed.success) {
      mealPlan.push(parsed.data);
    } else {
      warnings.push(`Meal plan entry ${index + 1} was skipped: ${describeIssue(parsed.error)}`);
    }
  });

  return {
    ok: true,
    backup: {
      format: LINKDISH_BACKUP_FORMAT,
      version: LINKDISH_BACKUP_VERSION,
      exportedAt: envelope.data.exportedAt,
      ...(envelope.data.app ? { app: envelope.data.app } : {}),
      recipes,
      ...(envelope.data.collections ? { collections } : {}),
      ...(envelope.data.mealPlan ? { mealPlan } : {})
    },
    warnings
  };
};

/**
 * Assembles a backup for export. `exportedAt` is passed in (not read from the clock) so the
 * function stays pure. The result satisfies `linkdishBackupSchema`.
 */
export const createLinkDishBackup = (input: {
  exportedAt: string;
  recipes: readonly BackupRecipe[];
  collections?: readonly BackupCollection[] | undefined;
  mealPlan?: readonly MealPlanEntry[] | undefined;
  app?: string | undefined;
}): LinkDishBackup => ({
  format: LINKDISH_BACKUP_FORMAT,
  version: LINKDISH_BACKUP_VERSION,
  exportedAt: input.exportedAt,
  ...(input.app ? { app: input.app } : {}),
  recipes: [...input.recipes],
  ...(input.collections ? { collections: [...input.collections] } : {}),
  ...(input.mealPlan ? { mealPlan: [...input.mealPlan] } : {})
});
