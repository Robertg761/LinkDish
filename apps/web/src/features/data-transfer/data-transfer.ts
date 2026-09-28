/**
 * The "Your data" flows the Settings page loads on demand: download a backup, export the cookbook
 * as text, and import a file (read → preview → commit). Everything happens in the browser;
 * nothing is uploaded.
 *
 * Import this module lazily (`await import(".../data-transfer/data-transfer")`) — it pulls in the
 * recipe-domain importers. For the tiny URL helpers use `./synthetic-url` directly.
 */
import { trackWebEvent } from "../../analytics/client";
import { getSavedRecipes } from "../library/saved-recipe-store";

import {
  backupFileName,
  buildBackup,
  buildCookbookMarkdown,
  cookbookFileName,
  downloadTextFile,
  serializeBackup
} from "./backup-export";
import { DataTransferError } from "./errors";
import { selectExportRecipes } from "./export-selection";
import { loadExportSnapshot } from "./export-snapshot";
import { analyzeImport, buildImportPlan } from "./import-plan";
import { parseImportFile, readFileBytes } from "./import-sources";
import { commitImport } from "./import-writer";
import { recordBackupDownloaded } from "./last-backup";

import type { ImportSource } from "./import-formats";
import type { DuplicateMode, ImportAnalysis, ImportPlan } from "./import-plan";
import type { ImportProgress } from "./import-sources";
import type { ImportResult } from "./import-writer";
import type { WebCollection } from "../../data/collections-store";
import type { MealPlanEntry } from "../../data/meal-plan-store";

const SETTINGS_ROUTE = "/settings";

const ANALYTICS_SOURCE: Record<ImportSource, string> = {
  linkdish: "linkdish_backup",
  mela: "mela",
  paprika: "paprika",
  schema_org: "schema_org"
};

/* ------------------------------------------------------------------------------------------------
 * Export
 * ---------------------------------------------------------------------------------------------- */

export interface ExportSummary {
  fileName: string;
  recipeCount: number;
  imageCount: number;
  bytes: number;
}

/** Builds the backup from this device and saves it as linkdish-backup-YYYY-MM-DD.json. */
export async function downloadBackup(options: {
  includeImages: boolean;
  now?: Date | undefined;
}): Promise<ExportSummary> {
  const now = options.now ?? new Date();
  // One transaction: the recipes, their scans, collections and meal plan of one moment.
  const { sourceImages, ...snapshot } = await loadExportSnapshot({
    includeImages: options.includeImages
  });
  const built = buildBackup(snapshot, {
    exportedAt: now.toISOString(),
    includeImages: options.includeImages,
    sourceImages
  });
  const fileName = backupFileName(now);
  // In pieces: a backup with many photos is too big for one string.
  const bytes = downloadTextFile(fileName, serializeBackup(built.backup), "application/json");
  recordBackupDownloaded(now);
  trackWebEvent({
    eventName: "library_exported",
    routeOrScreen: SETTINGS_ROUTE,
    properties: {
      recipe_count: built.recipeCount,
      include_images: options.includeImages,
      format: "backup"
    }
  });

  return {
    fileName,
    recipeCount: built.recipeCount,
    imageCount: built.imageCount,
    bytes
  };
}

/** Saves every exported recipe as one Markdown document (linkdish-cookbook-YYYY-MM-DD.md). */
export async function downloadCookbookText(
  options: { now?: Date | undefined } = {}
): Promise<ExportSummary> {
  const now = options.now ?? new Date();
  const recipes = await getSavedRecipes();
  const markdown = buildCookbookMarkdown(recipes, { exportedAt: now });
  const fileName = cookbookFileName(now);
  const recipeCount = selectExportRecipes(recipes).length;

  downloadTextFile(fileName, markdown, "text/markdown;charset=utf-8");
  trackWebEvent({
    eventName: "library_exported",
    routeOrScreen: SETTINGS_ROUTE,
    properties: { recipe_count: recipeCount, include_images: false, format: "markdown" }
  });

  return { fileName, recipeCount, imageCount: 0, bytes: markdown.length };
}

/* ------------------------------------------------------------------------------------------------
 * Import
 * ---------------------------------------------------------------------------------------------- */

export interface PreparedImport {
  analysis: ImportAnalysis;
  existingRecipeIds: ReadonlySet<string>;
  existingCollections: readonly WebCollection[];
  existingMealPlan: readonly MealPlanEntry[];
}

/** Reads, recognizes and analyzes a file against the cookbook (nothing is written). */
export async function prepareImport(
  file: File,
  options: {
    onProgress?: ((progress: ImportProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
  } = {}
): Promise<PreparedImport> {
  const bytes = await readFileBytes(file);
  const parsed = await parseImportFile({ name: file.name, bytes }, options);
  let cookbook;

  try {
    // One moment's cookbook for the preview; the import itself re-reads what it needs as it writes.
    cookbook = await loadExportSnapshot();
  } catch {
    throw new DataTransferError("storage_unavailable");
  }

  return {
    analysis: await analyzeImport(parsed, cookbook.recipes),
    existingRecipeIds: new Set(cookbook.recipes.map((recipe) => recipe.id)),
    existingCollections: cookbook.collections,
    existingMealPlan: cookbook.mealPlan
  };
}

/** What committing would do right now (for the preview sheet). */
export const previewImport = (
  prepared: PreparedImport,
  options: { duplicateMode: DuplicateMode; isPremium: boolean }
): ImportPlan => {
  let previewIds = 0;

  return buildImportPlan(prepared.analysis, {
    ...options,
    existingRecipeIds: prepared.existingRecipeIds,
    quotaUsed: prepared.analysis.quotaUsed,
    untouchedStarterIds: prepared.analysis.untouchedStarterIds,
    existingCollectionIds: prepared.analysis.existingCollectionIds,
    recipesSavedSinceAnalysis: [],
    existingCollections: prepared.existingCollections,
    existingMealPlan: prepared.existingMealPlan,
    now: new Date().toISOString(),
    // Placeholder ids: the real ones are made when the import is written.
    createId: () => `preview-${(previewIds += 1)}`
  });
};

/** Writes the import in one transaction and records `library_imported`. */
export async function runImport(
  prepared: PreparedImport,
  options: {
    duplicateMode: DuplicateMode;
    isPremium: boolean;
    onProgress?: ((progress: ImportProgress) => void) | undefined;
  }
): Promise<ImportResult> {
  const result = await commitImport(prepared.analysis, options);
  const { counts } = result.plan;

  trackWebEvent({
    eventName: "library_imported",
    routeOrScreen: SETTINGS_ROUTE,
    properties: {
      source: ANALYTICS_SOURCE[prepared.analysis.parsed.source],
      recipe_count: counts.imported + counts.restoredStarters,
      skipped_duplicates: counts.skippedDuplicates,
      over_limit: counts.overLimit,
      duplicate_mode: options.duplicateMode
    }
  });

  return result;
}
