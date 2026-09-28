/**
 * The web app's additions to the shared LinkDish backup format.
 *
 * The backup itself is the domain's versioned `linkdishBackupSchema` (recipes with personal
 * metadata, collections, meal plan), so any LinkDish app can restore it. A few things only the web
 * app keeps — collection emoji and order, how a recipe was extracted, preferred servings and,
 * optionally, the original scans of photo imports — travel in one extra top-level field,
 * {@link WEB_BACKUP_EXTRAS_KEY}. The domain validator ignores unknown fields, so other apps and
 * older builds still restore the rest; this module re-reads the field tolerantly, one record at a
 * time, so a damaged entry only loses that entry.
 */
import {
  extractRecipeImageSchema,
  extractionProvenanceSchema,
  extractionStrategySchema,
  fetchModeSchema
} from "@linkdish/api-contracts";
import { z } from "zod";

import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";

export const WEB_BACKUP_EXTRAS_KEY = "linkdishWeb";
export const WEB_BACKUP_EXTRAS_VERSION = 1;
export const BACKUP_APP_LABEL = "LinkDish web";

const MAX_SOURCE_IMAGES_PER_RECIPE = 12;

const webRecipeExtrasSchema = z.object({
  extraction: z
    .object({
      fetchMode: fetchModeSchema,
      provenance: z.array(extractionProvenanceSchema).max(12),
      strategy: extractionStrategySchema,
      warnings: z.array(z.string().max(500)).max(50)
    })
    .optional(),
  lastCookedAt: z.string().datetime().optional(),
  lastOpenedAt: z.string().datetime().optional(),
  preferredServings: z.number().positive().max(1_000).optional()
});

const webCollectionExtrasSchema = z.object({
  emoji: z.string().trim().min(1).max(16).optional(),
  description: z.string().trim().min(1).max(280).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
});

const webMealPlanExtrasSchema = z.object({
  createdAt: z.string().datetime().optional()
});

const sourceImagesSchema = z
  .array(extractRecipeImageSchema)
  .min(1)
  .max(MAX_SOURCE_IMAGES_PER_RECIPE);

export type WebRecipeExtras = z.infer<typeof webRecipeExtrasSchema>;
export type WebCollectionExtras = z.infer<typeof webCollectionExtrasSchema>;
export type WebMealPlanExtras = z.infer<typeof webMealPlanExtrasSchema>;

export interface WebBackupExtras {
  version: typeof WEB_BACKUP_EXTRAS_VERSION;
  recipes: Record<string, WebRecipeExtras>;
  collections: Record<string, WebCollectionExtras>;
  mealPlan: Record<string, WebMealPlanExtras>;
  /** Original scans of photo imports, by recipe id. Present only when the user included them. */
  sourceImages?: Record<string, ExtractRecipeImage[]> | undefined;
}

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parseEach = <T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>) => {
  const parsed: Record<string, T> = {};
  let skipped = 0;

  for (const [key, entry] of Object.entries(recordOf(value))) {
    const result = schema.safeParse(entry);

    if (result.success) {
      parsed[key] = result.data;
    } else {
      skipped += 1;
    }
  }

  return { parsed, skipped };
};

/**
 * Reads the web extras from a parsed backup file. Missing or unknown-version extras yield empty
 * maps; invalid records are dropped and counted in `skipped`.
 */
export const readWebBackupExtras = (
  backupJson: unknown
): { extras: WebBackupExtras; skipped: number } => {
  const raw = recordOf(recordOf(backupJson)[WEB_BACKUP_EXTRAS_KEY]);

  if (raw.version !== WEB_BACKUP_EXTRAS_VERSION) {
    return {
      extras: { version: WEB_BACKUP_EXTRAS_VERSION, recipes: {}, collections: {}, mealPlan: {} },
      skipped: 0
    };
  }

  const recipes = parseEach(raw.recipes, webRecipeExtrasSchema);
  const collections = parseEach(raw.collections, webCollectionExtrasSchema);
  const mealPlan = parseEach(raw.mealPlan, webMealPlanExtrasSchema);
  const sourceImages = parseEach(raw.sourceImages, sourceImagesSchema);

  return {
    extras: {
      version: WEB_BACKUP_EXTRAS_VERSION,
      recipes: recipes.parsed,
      collections: collections.parsed,
      mealPlan: mealPlan.parsed,
      ...(Object.keys(sourceImages.parsed).length > 0 ? { sourceImages: sourceImages.parsed } : {})
    },
    skipped: recipes.skipped + collections.skipped + mealPlan.skipped + sourceImages.skipped
  };
};

/** The web-only recipe fields worth keeping in a backup. */
export const toWebRecipeExtras = (recipe: WebSavedRecipe): WebRecipeExtras | null => {
  const extras: WebRecipeExtras = {
    extraction: {
      fetchMode: recipe.extraction.fetchMode,
      provenance: recipe.extraction.provenance.slice(0, 12),
      strategy: recipe.extraction.strategy,
      warnings: recipe.extraction.warnings.slice(0, 50).map((warning) => warning.slice(0, 500))
    },
    ...(recipe.lastCookedAt ? { lastCookedAt: recipe.lastCookedAt } : {}),
    ...(recipe.lastOpenedAt ? { lastOpenedAt: recipe.lastOpenedAt } : {}),
    ...(recipe.preferredServings && recipe.preferredServings <= 1_000
      ? { preferredServings: recipe.preferredServings }
      : {})
  };

  return webRecipeExtrasSchema.safeParse(extras).success ? extras : null;
};
