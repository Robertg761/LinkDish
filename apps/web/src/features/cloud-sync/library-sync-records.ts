/**
 * How this browser's recipes and collections read as cloud library items (`LibraryRecipe`,
 * `LibraryCollection`), and how an item from the cloud is stored back. Device-only fields (scans,
 * when a recipe was last opened, its Family link) stay as they are on this device.
 */
import { stableStringify } from "@linkdish/recipe-domain/src/library-sync";
import { isHttpUrl } from "@linkdish/recipe-domain/src/recipe-schema";

import { getSourceHost } from "../library/saved-recipe-store";

import type { WebCollection } from "../../data/collections-store";
import type {
  RecipeCookLogEntry,
  RecipeRating,
  WebSavedRecipe
} from "../library/saved-recipe-types";
import type { LibraryCollection, LibraryRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

/* Mirrors the API's limits (MAX_LIBRARY_* in @linkdish/api-contracts) without loading it. */
const MAX_NOTES_LENGTH = 20_000;
const MAX_COOK_LOG_ENTRIES = 100;
const MAX_COOK_LOG_NOTE_LENGTH = 1_000;
const MAX_ITEM_ID_LENGTH = 180;

const STARTER_RECIPE_ID_PREFIX = "starter-";

/** Starter recipes are this browser's own; everything else in the cookbook syncs. */
export const isSyncedRecipe = (recipe: Pick<WebSavedRecipe, "id">): boolean =>
  !recipe.id.startsWith(STARTER_RECIPE_ID_PREFIX) && recipe.id.length <= MAX_ITEM_ID_LENGTH;

export const isSyncedCollection = (collection: Pick<WebCollection, "id">): boolean =>
  collection.id.length <= MAX_ITEM_ID_LENGTH;

/** The recipe with the link it is saved with (which the editor can change apart from it). */
const recipeWithLink = (record: WebSavedRecipe): Recipe =>
  isHttpUrl(record.sourceUrl) && record.sourceUrl !== record.recipe.sourceUrl
    ? { ...record.recipe, sourceUrl: record.sourceUrl }
    : record.recipe;

const cookLogOf = (cookLog: readonly RecipeCookLogEntry[]): LibraryRecipe["cookLog"] =>
  cookLog.slice(-MAX_COOK_LOG_ENTRIES).map((entry) => {
    const note = entry.note?.slice(0, MAX_COOK_LOG_NOTE_LENGTH);
    return note ? { cookedAt: entry.cookedAt, note } : { cookedAt: entry.cookedAt };
  });

/** A saved recipe as the cloud keeps it. Empty and default values are left out. */
export const toLibraryRecipe = (record: WebSavedRecipe): LibraryRecipe => {
  const notes = record.notes?.trim().slice(0, MAX_NOTES_LENGTH);

  return {
    createdAt: record.createdAt,
    fetchMode: record.extraction.fetchMode,
    provenance: record.extraction.provenance,
    recipe: recipeWithLink(record),
    strategy: record.extraction.strategy,
    warnings: record.extraction.warnings,
    ...(notes ? { notes } : {}),
    ...(record.clonedFromId ? { clonedFromId: record.clonedFromId } : {}),
    ...(record.favorite ? { favorite: true } : {}),
    ...(record.tags?.length ? { tags: record.tags } : {}),
    ...(record.collectionIds?.length ? { collectionIds: record.collectionIds } : {}),
    ...(record.rating ? { rating: record.rating } : {}),
    ...(record.cookLog?.length ? { cookLog: cookLogOf(record.cookLog) } : {}),
    ...(record.timesCooked ? { timesCooked: record.timesCooked } : {}),
    ...(record.lastCookedAt ? { lastCookedAt: record.lastCookedAt } : {}),
    ...(record.preferredServings ? { preferredServings: record.preferredServings } : {})
  };
};

export const toLibraryCollection = (collection: WebCollection): LibraryCollection => ({
  createdAt: collection.createdAt,
  name: collection.name,
  sortOrder: collection.sortOrder,
  ...(collection.emoji ? { emoji: collection.emoji } : {}),
  ...(collection.description ? { description: collection.description } : {})
});

const SYNCED_OPTIONAL_KEYS = [
  "notes",
  "clonedFromId",
  "favorite",
  "tags",
  "collectionIds",
  "rating",
  "cookLog",
  "lastCookedAt",
  "preferredServings"
] as const;

const laterOf = (left: string, right: string): string => (left > right ? left : right);

/**
 * The record to store for a recipe that arrived from the cloud (or merged with it): `existing`
 * (as stored, `undefined` for a new one) with the cloud's fields. An edit to the recipe or its
 * notes moves it up the cookbook, as an edit here does, and leaves its Family copy behind.
 */
export const fromLibraryRecipe = (
  existing: WebSavedRecipe | undefined,
  id: string,
  item: LibraryRecipe,
  updatedAt: string
): WebSavedRecipe => {
  const edited =
    !existing ||
    stableStringify(recipeWithLink(existing)) !== stableStringify(item.recipe) ||
    (existing.notes?.trim() || undefined) !== item.notes;
  const sync = existing?.sync ?? { status: "local_only" as const };
  const next: WebSavedRecipe = {
    ...existing,
    createdAt: item.createdAt,
    extraction: {
      fetchMode: item.fetchMode,
      provenance: item.provenance,
      strategy: item.strategy,
      warnings: item.warnings
    },
    id,
    recipe: item.recipe,
    sourceHost: getSourceHost(item.recipe.sourceUrl),
    sourceUrl: item.recipe.sourceUrl,
    sync: edited && sync.sharedRecipeId ? { ...sync, status: "dirty" } : sync,
    timesCooked: item.timesCooked ?? 0,
    updatedAt: existing
      ? edited
        ? laterOf(existing.updatedAt, updatedAt)
        : existing.updatedAt
      : updatedAt
  };

  for (const key of SYNCED_OPTIONAL_KEYS) {
    delete next[key];
  }

  return {
    ...next,
    ...(item.notes ? { notes: item.notes } : {}),
    ...(item.clonedFromId ? { clonedFromId: item.clonedFromId } : {}),
    ...(item.favorite ? { favorite: true } : {}),
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(item.collectionIds?.length ? { collectionIds: item.collectionIds } : {}),
    ...(item.rating ? { rating: item.rating as RecipeRating } : {}),
    ...(item.cookLog?.length ? { cookLog: item.cookLog } : {}),
    ...(item.lastCookedAt ? { lastCookedAt: item.lastCookedAt } : {}),
    ...(item.preferredServings ? { preferredServings: item.preferredServings } : {})
  };
};

export const fromLibraryCollection = (
  existing: WebCollection | undefined,
  id: string,
  item: LibraryCollection,
  updatedAt: string
): WebCollection => ({
  createdAt: item.createdAt,
  id,
  name: item.name,
  sortOrder: item.sortOrder,
  updatedAt: existing ? laterOf(existing.updatedAt, updatedAt) : updatedAt,
  ...(item.emoji ? { emoji: item.emoji } : {}),
  ...(item.description ? { description: item.description } : {})
});
