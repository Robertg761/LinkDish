/**
 * Exporting the cookbook: a versioned LinkDish backup (JSON, restorable by any LinkDish app) and
 * a human-readable Markdown cookbook.
 *
 * What goes in: every personal recipe with its local metadata (favorite, tags, collections,
 * rating, notes, cook log, times cooked, timestamps), the collections and the meal plan.
 * Starter recipes are included only once someone made them their own (favorited, tagged, rated,
 * noted, cooked, filed in a collection or edited) — an untouched starter is re-created on any
 * new device anyway, so backing it up would only add noise. Original scans of photo imports are
 * optional because they can be large.
 */
import {
  createLinkDishBackup,
  MAX_BACKUP_NOTES_LENGTH,
  MAX_BACKUP_TAG_LENGTH,
  MAX_BACKUP_TAGS,
  MAX_MEAL_PLAN_NOTE_LENGTH,
  MAX_MEAL_PLAN_SERVINGS,
  recipeToMarkdown
} from "@linkdish/recipe-domain";

import {
  BACKUP_APP_LABEL,
  toWebRecipeExtras,
  WEB_BACKUP_EXTRAS_KEY,
  WEB_BACKUP_EXTRAS_VERSION
} from "./backup-format";
import { selectExportRecipes } from "./export-selection";
import { isLinkDishInternalSourceUrl } from "./synthetic-url";

import type { WebBackupExtras, WebCollectionExtras, WebRecipeExtras } from "./backup-format";
import type { WebCollection } from "../../data/collections-store";
import type { MealPlanEntry } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";
import type {
  BackupCollection,
  BackupRecipe,
  LinkDishBackup,
  MealPlanEntry as BackupMealPlanEntry
} from "@linkdish/recipe-domain";

export interface ExportSnapshot {
  recipes: readonly WebSavedRecipe[];
  collections: readonly WebCollection[];
  mealPlan: readonly MealPlanEntry[];
}

export type WebLinkDishBackup = LinkDishBackup & { [WEB_BACKUP_EXTRAS_KEY]: WebBackupExtras };

export interface BuildBackupOptions {
  exportedAt: string;
  /** Original scans by recipe id; included only when `includeImages` is true. */
  sourceImages?: ReadonlyMap<string, ExtractRecipeImage[]> | undefined;
  includeImages: boolean;
}

export interface BuiltBackup {
  backup: WebLinkDishBackup;
  recipeCount: number;
  imageCount: number;
}

const MAX_BACKUP_COOK_LOG_NOTE_LENGTH = 2_000;

const toBackupRecipe = (recipe: WebSavedRecipe): BackupRecipe => {
  const notes = recipe.notes?.trim();
  const tags = (recipe.tags ?? [])
    .map((tag) => tag.trim().slice(0, MAX_BACKUP_TAG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_BACKUP_TAGS);
  const cookLog = (recipe.cookLog ?? []).map((entry) => ({
    cookedAt: entry.cookedAt,
    ...(entry.note?.trim()
      ? { note: entry.note.trim().slice(0, MAX_BACKUP_COOK_LOG_NOTE_LENGTH) }
      : {})
  }));

  return {
    id: recipe.id,
    recipe: recipe.recipe,
    meta: {
      ...(recipe.favorite ? { favorite: true } : {}),
      ...(tags.length ? { tags } : {}),
      ...(recipe.rating ? { rating: recipe.rating } : {}),
      ...(notes ? { notes: notes.slice(0, MAX_BACKUP_NOTES_LENGTH) } : {}),
      timesCooked: Math.max(0, Math.round(recipe.timesCooked ?? 0)),
      ...(cookLog.length ? { cookLog } : {}),
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
      sourceUrl: recipe.sourceUrl
    }
  };
};

const toBackupMealPlanEntry = (entry: MealPlanEntry): BackupMealPlanEntry => ({
  id: entry.id,
  date: entry.date,
  slot: entry.slot,
  title: entry.title,
  ...(entry.recipeId ? { recipeId: entry.recipeId } : {}),
  ...(entry.servings && entry.servings <= MAX_MEAL_PLAN_SERVINGS
    ? { servings: entry.servings }
    : {}),
  ...(entry.note ? { note: entry.note.slice(0, MAX_MEAL_PLAN_NOTE_LENGTH) } : {}),
  updatedAt: entry.updatedAt
});

/** Assembles the backup file contents. Pure: timestamps and images are passed in. */
export const buildBackup = (snapshot: ExportSnapshot, options: BuildBackupOptions): BuiltBackup => {
  const recipes = selectExportRecipes(snapshot.recipes);
  const recipeExtras: Record<string, WebRecipeExtras> = {};
  const collectionExtras: Record<string, WebCollectionExtras> = {};
  const mealPlanExtras: WebBackupExtras["mealPlan"] = {};
  const sourceImages: Record<string, ExtractRecipeImage[]> = {};
  let imageCount = 0;

  for (const recipe of recipes) {
    const extras = toWebRecipeExtras(recipe);

    if (extras) {
      recipeExtras[recipe.id] = extras;
    }

    const images = options.includeImages ? options.sourceImages?.get(recipe.id) : undefined;

    if (images?.length) {
      sourceImages[recipe.id] = images;
      imageCount += images.length;
    }
  }

  const collections: BackupCollection[] = snapshot.collections.map((collection) => {
    collectionExtras[collection.id] = {
      sortOrder: Math.max(0, Math.round(collection.sortOrder)),
      ...(collection.emoji ? { emoji: collection.emoji } : {}),
      ...(collection.description ? { description: collection.description } : {})
    };

    return {
      id: collection.id,
      name: collection.name,
      recipeIds: recipes
        .filter((recipe) => recipe.collectionIds?.includes(collection.id))
        .map((recipe) => recipe.id),
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt
    };
  });

  for (const entry of snapshot.mealPlan) {
    mealPlanExtras[entry.id] = { createdAt: entry.createdAt };
  }

  const extras: WebBackupExtras = {
    version: WEB_BACKUP_EXTRAS_VERSION,
    recipes: recipeExtras,
    collections: collectionExtras,
    mealPlan: mealPlanExtras,
    ...(imageCount > 0 ? { sourceImages } : {})
  };

  return {
    backup: {
      ...createLinkDishBackup({
        exportedAt: options.exportedAt,
        app: BACKUP_APP_LABEL,
        recipes: recipes.map(toBackupRecipe),
        collections,
        mealPlan: snapshot.mealPlan.map(toBackupMealPlanEntry)
      }),
      [WEB_BACKUP_EXTRAS_KEY]: extras
    },
    recipeCount: recipes.length,
    imageCount
  };
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** "2026-09-28" in the user's local time zone. */
export const localDateStamp = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const backupFileName = (date: Date): string =>
  `linkdish-backup-${localDateStamp(date)}.json`;

export const cookbookFileName = (date: Date): string =>
  `linkdish-cookbook-${localDateStamp(date)}.md`;

/* ------------------------------------------------------------------------------------------------
 * Markdown cookbook
 * ---------------------------------------------------------------------------------------------- */

const MARKDOWN_SPECIAL_PATTERN = /([\\`*_[\]<>|#])/gu;
const HEADING_PATTERN = /^(#{1,5}) /gmu;

const escapeInline = (text: string): string => text.replace(MARKDOWN_SPECIAL_PATTERN, "\\$1");

const personalLine = (recipe: WebSavedRecipe): string | null => {
  const parts = [
    recipe.favorite ? "♥ Favorite" : null,
    recipe.rating ? `${"★".repeat(recipe.rating)}${"☆".repeat(5 - recipe.rating)}` : null,
    recipe.tags?.length ? `Tags: ${recipe.tags.map(escapeInline).join(", ")}` : null,
    recipe.timesCooked ? `Cooked ${recipe.timesCooked}×` : null
  ].filter(Boolean);

  return parts.length ? `_${parts.join(" · ")}_` : null;
};

/**
 * The cookbook as one Markdown document: a title, then every exported recipe (A–Z) with its
 * personal line (favorite, rating, tags) and notes, separated by rules.
 */
export const buildCookbookMarkdown = (
  recipes: readonly WebSavedRecipe[],
  options: { exportedAt: Date }
): string => {
  const selected = selectExportRecipes(recipes).sort((left, right) =>
    left.recipe.title.localeCompare(right.recipe.title, undefined, { sensitivity: "base" })
  );
  const dateLabel = options.exportedAt.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  const header = [
    "# My LinkDish cookbook",
    `_${selected.length} recipe${selected.length === 1 ? "" : "s"} · exported ${dateLabel}_`
  ].join("\n\n");

  const sections = selected.map((recipe) => {
    const markdown = recipeToMarkdown(recipe.recipe, {
      notes: recipe.notes ?? null,
      // Made-up import and photo-scan addresses are not pages anyone can open.
      includeSource: !isLinkDishInternalSourceUrl(recipe.sourceUrl)
    })
      .trimEnd()
      // Each recipe's "# Title" becomes "## Title" under the cookbook heading.
      .replace(HEADING_PATTERN, "#$1 ");
    const personal = personalLine(recipe);

    if (!personal) {
      return markdown;
    }

    const [heading, ...rest] = markdown.split("\n");
    return [heading, "", personal, ...rest].join("\n");
  });

  return `${[header, ...sections].join("\n\n---\n\n")}\n`;
};

/* ------------------------------------------------------------------------------------------------
 * Downloads
 * ---------------------------------------------------------------------------------------------- */

/**
 * The backup as JSON text in pieces. The scans (by far the biggest part) go in one piece per
 * recipe, so no single string ever holds all of them: browsers cap a string's length (about 2^29
 * characters in V8), and one giant string would also cost its size again in memory. Joined, the
 * pieces are exactly `JSON.stringify(backup)`.
 */
export const serializeBackup = (backup: WebLinkDishBackup): string[] => {
  const extras = backup[WEB_BACKUP_EXTRAS_KEY];
  const entries = Object.entries(extras.sourceImages ?? {});

  if (entries.length === 0) {
    return [JSON.stringify(backup)];
  }

  // Serialize everything else with a unique stand-in where the scans go, then split around it.
  const marker = JSON.stringify(`linkdish-source-images-${crypto.randomUUID()}`);
  const skeleton = JSON.stringify({
    ...backup,
    [WEB_BACKUP_EXTRAS_KEY]: { ...extras, sourceImages: JSON.parse(marker) as string }
  });
  const at = skeleton.indexOf(marker);
  const parts = [skeleton.slice(0, at), "{"];

  entries.forEach(([recipeId, images], index) => {
    parts.push(`${index > 0 ? "," : ""}${JSON.stringify(recipeId)}:${JSON.stringify(images)}`);
  });
  parts.push("}", skeleton.slice(at + marker.length));

  return parts;
};

/**
 * Saves text (one string, or pieces joined in order) as a file through a temporary object URL
 * (nothing leaves the device). Returns the file's size in bytes.
 */
export const downloadTextFile = (
  fileName: string,
  text: string | readonly string[],
  mimeType: string
): number => {
  const blob = new Blob(typeof text === "string" ? [text] : [...text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the URL after click returns; give them a moment before releasing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return blob.size;
};
