import { apiClient } from "../../api/client";
import { isCachedUserPremium } from "../../auth/auth-cache";
import { emitDataChange } from "../../data/change-feed";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";
import {
  COOK_SESSIONS_STORE_NAME,
  getLinkDishWebDb,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";

import type {
  RecipeCookLogEntry,
  RecipeRating,
  WebRecipeSourceImagesRecord,
  WebSavedRecipe,
  WebSavedRecipeMetadataKey
} from "./saved-recipe-types";
import type {
  ExtractRecipeImage,
  FetchMode,
  ExtractionProvenance,
  ExtractionStrategy,
  SharedRecipe
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

const STORE_NAME = SAVED_RECIPES_STORE_NAME;
const IMAGES_STORE_NAME = RECIPE_SOURCE_IMAGES_STORE_NAME;
const STARTER_RECIPES_SEEDED_STORAGE_KEY = "linkdish:web:starter-recipes-seeded:v1";
const STARTER_RECIPE_ID_PREFIX = "starter-";
const MAX_COOK_LOG_ENTRIES = 100;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 32;

export const LOCAL_LIMIT_FREE = 15;

export const getDb = getLinkDishWebDb;

/** Thrown when a free user would go past {@link LOCAL_LIMIT_FREE} personal recipes. */
export class SavedRecipeLimitError extends Error {
  public readonly code = "limit_exceeded" as const;

  public constructor(public readonly limit: number = LOCAL_LIMIT_FREE) {
    super(`Free cookbooks hold up to ${limit} personal recipes.`);
    this.name = "SavedRecipeLimitError";
  }
}

export interface SavedRecipeQuotaOptions {
  /**
   * Whether the signed-in user has unlimited saves (Plus or Family). When omitted, the last known
   * signed-in user's plan is used.
   */
  isPremiumUser?: boolean | undefined;
}

export async function generateDeterministicId(
  sourceUrl: string,
  recipeName: string
): Promise<string> {
  try {
    const data = new TextEncoder().encode(sourceUrl + recipeName);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return crypto.randomUUID();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Record helpers
 * ---------------------------------------------------------------------------------------------- */

interface SplitRecord {
  /** `undefined` leaves the images store untouched; `[]` removes the images. */
  images: ExtractRecipeImage[] | undefined;
  record: WebSavedRecipe;
}

const isStarterRecipeId = (id: IDBValidKey): boolean =>
  typeof id === "string" && id.startsWith(STARTER_RECIPE_ID_PREFIX);

/**
 * Only the seeded starters (ids "starter-…") are starter recipes, which is also how the free
 * limit counts. Older versions' "Duplicate" of a starter kept `isStarter` under a fresh id; that
 * copy is a personal recipe, so every read and write drops the flag from it.
 */
const withStarterFlagById = (recipe: WebSavedRecipe): WebSavedRecipe => {
  if (!recipe.isStarter || isStarterRecipeId(recipe.id)) {
    return recipe;
  }

  const personal: WebSavedRecipe = { ...recipe };
  delete personal.isStarter;
  return personal;
};

/** Separates the heavy `sourceImages` payload from the record that goes into `savedRecipes`. */
const splitSourceImages = (input: WebSavedRecipe): SplitRecord => {
  const recipe = withStarterFlagById(input);

  if (!("sourceImages" in recipe)) {
    return { images: undefined, record: recipe };
  }

  const { sourceImages, ...rest } = recipe;

  if (sourceImages === undefined) {
    return { images: undefined, record: rest };
  }

  if (sourceImages.length === 0) {
    const withoutCount: WebSavedRecipe = { ...rest };
    delete withoutCount.sourceImageCount;
    return { images: [], record: withoutCount };
  }

  return { images: sourceImages, record: { ...rest, sourceImageCount: sourceImages.length } };
};

/** The lightweight shape list reads return: never carries `sourceImages`. */
export const toSavedRecipeListRecord = (recipe: WebSavedRecipe): WebSavedRecipe =>
  splitSourceImages(recipe).record;

const withImages = (
  record: WebSavedRecipe,
  images: ExtractRecipeImage[] | undefined
): WebSavedRecipe => (images?.length ? { ...record, sourceImages: images } : record);

const timestampOf = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

const sortByUpdatedAtDesc = (recipes: WebSavedRecipe[]): WebSavedRecipe[] =>
  recipes
    .map((recipe) => ({ recipe, time: timestampOf(recipe.updatedAt) }))
    .sort((a, b) => b.time - a.time)
    .map((entry) => entry.recipe);

const imagesRecordFor = (
  recipeId: string,
  images: ExtractRecipeImage[],
  updatedAt: string
): WebRecipeSourceImagesRecord => ({ images, recipeId, updatedAt });

/* ------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/** All saved recipes, newest update first. List records never include `sourceImages`. */
export async function getSavedRecipes(): Promise<WebSavedRecipe[]> {
  const db = await getDb();
  const recipes = (await db.getAll(STORE_NAME)) as WebSavedRecipe[];
  return sortByUpdatedAtDesc(recipes.map(toSavedRecipeListRecord));
}

/** Hostname for a recipe source, or "unknown" when the URL cannot be parsed. */
export const getSourceHost = (sourceUrl: string): string => {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "unknown";
  }
};

/** The original scans for an image-imported recipe (empty when there are none). */
export async function getSavedRecipeSourceImages(id: string): Promise<ExtractRecipeImage[]> {
  const db = await getDb();
  const stored = (await db.get(IMAGES_STORE_NAME, id)) as WebRecipeSourceImagesRecord | undefined;

  if (stored?.images?.length) {
    return stored.images;
  }

  // Records written before the v4 migration ran still embed their images.
  const legacy = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
  return legacy?.sourceImages ?? [];
}

/** One saved recipe with its `sourceImages` hydrated (backward compatible detail read). */
export async function getSavedRecipeById(id: string): Promise<WebSavedRecipe | undefined> {
  const db = await getDb();
  const stored = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;

  if (!stored) {
    return undefined;
  }

  const record = withStarterFlagById(stored);

  if (record.sourceImages?.length) {
    return record;
  }

  const images = (await db.get(IMAGES_STORE_NAME, id)) as WebRecipeSourceImagesRecord | undefined;
  return withImages(record, images?.images);
}

/** Alias of {@link getSavedRecipeById}. */
export const getSavedRecipe = getSavedRecipeById;

export async function countSavedRecipes(): Promise<number> {
  const db = await getDb();
  return db.count(STORE_NAME);
}

/** Personal recipes that count toward the free limit (starter recipes are excluded). */
export async function countQuotaSavedRecipes(): Promise<number> {
  const db = await getDb();
  const keys = await db.getAllKeys(STORE_NAME);
  return keys.filter((key) => !isStarterRecipeId(key)).length;
}

/** Throws {@link SavedRecipeLimitError} when a free user has no room for another recipe. */
export async function assertCanAddSavedRecipe(options?: SavedRecipeQuotaOptions): Promise<void> {
  const isPremiumUser = options?.isPremiumUser ?? isCachedUserPremium();

  if (isPremiumUser) {
    return;
  }

  if ((await countQuotaSavedRecipes()) >= LOCAL_LIMIT_FREE) {
    throw new SavedRecipeLimitError();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------------------------------- */

/** Writes the record and its images atomically; returns the stored (image-free) record. */
async function writeSavedRecipe(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  const db = await getDb();
  const { images, record } = splitSourceImages(recipe);

  if (images === undefined) {
    await db.put(STORE_NAME, record);
  } else {
    const tx = db.transaction([STORE_NAME, IMAGES_STORE_NAME], "readwrite");
    const imagesStore = tx.objectStore(IMAGES_STORE_NAME);

    await Promise.all([
      tx.objectStore(STORE_NAME).put(record),
      images.length
        ? imagesStore.put(imagesRecordFor(record.id, images, record.updatedAt))
        : imagesStore.delete(record.id),
      tx.done
    ]);
  }

  emitDataChange({ topic: "savedRecipes", upserted: [record] });
  return record;
}

/**
 * Read-modify-write of one stored record in a single transaction, so concurrent metadata updates
 * never overwrite each other. Returns the stored (image-free) record.
 */
async function patchStoredRecipe(
  id: string,
  updater: (existing: WebSavedRecipe) => WebSavedRecipe
): Promise<WebSavedRecipe | undefined> {
  const db = await getDb();
  const tx = db.transaction([STORE_NAME, IMAGES_STORE_NAME], "readwrite");
  const recipes = tx.objectStore(STORE_NAME);
  const existing = (await recipes.get(id)) as WebSavedRecipe | undefined;

  if (!existing) {
    await tx.done;
    return undefined;
  }

  const { images, record } = splitSourceImages(updater(existing));
  await recipes.put(record);

  if (images !== undefined) {
    const imagesStore = tx.objectStore(IMAGES_STORE_NAME);
    await (images.length
      ? imagesStore.put(imagesRecordFor(record.id, images, record.updatedAt))
      : imagesStore.delete(record.id));
  }

  await tx.done;
  emitDataChange({ topic: "savedRecipes", upserted: [record] });
  return record;
}

const hydrateImages = async (record: WebSavedRecipe | undefined) => {
  if (!record?.sourceImageCount) {
    return record;
  }

  return withImages(record, await getSavedRecipeSourceImages(record.id));
};

export async function seedStarterRecipesIfNeeded(): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const hasSeededStarterRecipes = safeGetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY) === "true";
  if (hasSeededStarterRecipes) {
    return;
  }

  if ((await countSavedRecipes()) > 0) {
    safeSetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
    return;
  }

  // Only first-run visitors need the starter recipes (and the recipe-domain code that builds
  // them), so they load on demand instead of sitting in the entry bundle.
  const { createStarterRecipeSeedRecords } = await import("./starter-recipe-seeds");
  const db = await getDb();
  const starterRecipes = createStarterRecipeSeedRecords();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const seeded: WebSavedRecipe[] = [];

  for (const starterRecipe of starterRecipes) {
    const savedRecipe: WebSavedRecipe = {
      id: starterRecipe.id,
      recipe: starterRecipe.recipe,
      sourceUrl: starterRecipe.recipe.sourceUrl,
      sourceHost: getSourceHost(starterRecipe.recipe.sourceUrl),
      createdAt: starterRecipe.savedAt,
      updatedAt: starterRecipe.savedAt,
      extraction: {
        fetchMode: starterRecipe.fetchMode,
        provenance: starterRecipe.provenance,
        strategy: starterRecipe.strategy,
        warnings: starterRecipe.warnings
      },
      isStarter: true,
      timesCooked: 0,
      sync: {
        status: "local_only"
      }
    };

    await store.put(savedRecipe);
    seeded.push(savedRecipe);
  }

  await tx.done;

  // Only mark the library as seeded once every starter recipe is written, so a
  // failure part-way through can be retried on the next launch.
  safeSetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
  emitDataChange({ topic: "savedRecipes", upserted: seeded });
}

export interface SaveRecipeInput {
  recipe: Recipe;
  sourceUrl: string;
  sourceImages?: ExtractRecipeImage[] | undefined;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
}

export async function saveRecipe(
  input: SaveRecipeInput,
  isPremiumUser: boolean
): Promise<{
  success: boolean;
  recipe?: WebSavedRecipe;
  error?: "limit_exceeded" | "duplicate_prompt";
}> {
  const db = await getDb();
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);

  // Check if same ID already exists
  const existing = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
  if (existing) {
    // Return explicit indicator to let user know they can replace it
    return { success: false, error: "duplicate_prompt" };
  }

  // Check limit if not premium
  if (!isPremiumUser) {
    const count = await countQuotaSavedRecipes();
    if (count >= LOCAL_LIMIT_FREE) {
      return { success: false, error: "limit_exceeded" };
    }
  }

  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    id,
    recipe: input.recipe,
    sourceUrl: input.sourceUrl,
    sourceHost: getSourceHost(input.sourceUrl),
    createdAt: now,
    updatedAt: now,
    extraction: input.extraction,
    sourceImages: input.sourceImages,
    timesCooked: 0,
    sync: {
      status: "local_only"
    }
  };

  const stored = await writeSavedRecipe(savedRecipe);
  return { success: true, recipe: withImages(stored, input.sourceImages) };
}

export async function forceSaveRecipe(input: SaveRecipeInput): Promise<WebSavedRecipe> {
  const db = await getDb();
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);
  const existing = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
  const existingSync = existing?.sync;
  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    // Personal notes and metadata survive a re-import of the same recipe.
    ...(existing ? toSavedRecipeListRecord(existing) : {}),
    id,
    recipe: input.recipe,
    sourceUrl: input.sourceUrl,
    sourceHost: getSourceHost(input.sourceUrl),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    extraction: input.extraction,
    timesCooked: existing?.timesCooked ?? 0,
    sync: existingSync?.sharedRecipeId
      ? {
          ...existingSync,
          status: "dirty"
        }
      : (existingSync ?? { status: "local_only" }),
    ...(input.sourceImages
      ? { sourceImages: input.sourceImages }
      : existing?.sourceImages
        ? { sourceImages: existing.sourceImages }
        : {})
  };

  const stored = await writeSavedRecipe(savedRecipe);
  return (await hydrateImages(stored)) ?? stored;
}

/**
 * Writes a full record. `sourceImages` on the input replace the stored images (`[]` removes them);
 * leaving it out keeps whatever images are stored. Returns the input as passed.
 */
export async function putSavedRecipe(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  await writeSavedRecipe(recipe);
  return recipe;
}

export async function updateSavedRecipe(
  id: string,
  update: {
    notes?: string | undefined;
    recipe: Recipe;
  }
): Promise<WebSavedRecipe | undefined> {
  const updated = await patchStoredRecipe(id, (existing) => ({
    ...existing,
    notes: update.notes?.trim() || undefined,
    recipe: update.recipe,
    updatedAt: new Date().toISOString(),
    sync: {
      ...(existing.sync || { status: "local_only" }),
      status: existing.sync?.sharedRecipeId ? "dirty" : (existing.sync?.status ?? "local_only")
    }
  }));

  return hydrateImages(updated);
}

/** Updates only the personal notes (synced to the household copy on the next sync). */
export async function updateRecipeNotes(
  id: string,
  notes: string | null | undefined
): Promise<WebSavedRecipe | undefined> {
  return patchStoredRecipe(id, (existing) => ({
    ...existing,
    notes: notes?.trim() || undefined,
    updatedAt: new Date().toISOString(),
    sync: {
      ...(existing.sync || { status: "local_only" }),
      status: existing.sync?.sharedRecipeId ? "dirty" : (existing.sync?.status ?? "local_only")
    }
  }));
}

const COPY_SUFFIX_PATTERN = /\s+\(copy(?:\s+\d+)?\)$/iu;

/** "Soup" → "Soup (copy)", then "Soup (copy 2)", … skipping titles already in the cookbook. */
export async function getUniqueCopyTitle(title: string): Promise<string> {
  const db = await getDb();
  const base = title.replace(COPY_SUFFIX_PATTERN, "").trim() || title.trim();
  let candidate = `${base} (copy)`;

  for (let index = 2; index < 1000; index += 1) {
    if ((await db.countFromIndex(STORE_NAME, "title", candidate)) === 0) {
      return candidate;
    }

    candidate = `${base} (copy ${index})`;
  }

  return candidate;
}

/**
 * Copies a personal recipe. The copy is a regular personal recipe: it counts toward the free
 * limit (throws {@link SavedRecipeLimitError} when full), is never a starter, and is local-only.
 */
export async function duplicateSavedRecipe(
  id: string,
  options?: SavedRecipeQuotaOptions
): Promise<WebSavedRecipe | undefined> {
  const existing = await getSavedRecipeById(id);

  if (!existing) {
    return undefined;
  }

  await assertCanAddSavedRecipe(options);

  // A copy is a fresh personal recipe: it keeps content, notes, tags and collections, but not
  // starter status, sync state or this copy's own cooking history.
  const copyable: WebSavedRecipe = { ...existing };
  delete copyable.cookLog;
  delete copyable.favorite;
  delete copyable.isStarter;
  delete copyable.lastCookedAt;
  delete copyable.lastOpenedAt;
  delete copyable.rating;
  const now = new Date().toISOString();
  const duplicate: WebSavedRecipe = {
    ...copyable,
    id: crypto.randomUUID(),
    recipe: {
      ...existing.recipe,
      ingredients: existing.recipe.ingredients.map((ingredient) => ({ ...ingredient })),
      steps: existing.recipe.steps.map((step) => ({ ...step })),
      title: await getUniqueCopyTitle(existing.recipe.title)
    },
    createdAt: now,
    updatedAt: now,
    timesCooked: 0,
    sync: {
      status: "local_only"
    }
  };

  return putSavedRecipe(duplicate);
}

export function sharedRecipeToWebSavedRecipe(sharedRecipe: SharedRecipe): WebSavedRecipe {
  return {
    id: sharedRecipe.sourceSavedRecipeId ?? `shared-${sharedRecipe.id}`,
    createdAt: sharedRecipe.createdAt,
    extraction: {
      fetchMode: sharedRecipe.fetchMode,
      provenance: sharedRecipe.provenance,
      strategy: sharedRecipe.strategy,
      warnings: sharedRecipe.warnings
    },
    notes: sharedRecipe.notes,
    recipe: sharedRecipe.recipe,
    sourceHost: getSharedRecipeSourceHost(sharedRecipe),
    sourceUrl: sharedRecipe.recipe.sourceUrl,
    timesCooked: 0,
    sync: {
      lastSyncedAt: sharedRecipe.updatedAt,
      sharedRecipeId: sharedRecipe.id,
      status: "synced"
    },
    updatedAt: sharedRecipe.updatedAt
  };
}

export function getSharedRecipeSourceHost(sharedRecipe: SharedRecipe): string {
  return getSourceHost(sharedRecipe.recipe.sourceUrl);
}

export function getSharedRecipeOwnerLabel(
  sharedRecipe: Pick<SharedRecipe, "ownerAvatarEmoji" | "ownerDisplayName" | "ownerEmail">
): string {
  const ownerName = sharedRecipe.ownerDisplayName?.trim() || sharedRecipe.ownerEmail;
  return sharedRecipe.ownerAvatarEmoji
    ? `${sharedRecipe.ownerAvatarEmoji} ${ownerName}`
    : ownerName;
}

/** Saves a household recipe as a personal copy (counts toward the free limit). */
export async function saveSharedRecipeCopy(
  sharedRecipe: SharedRecipe,
  options?: SavedRecipeQuotaOptions
): Promise<WebSavedRecipe> {
  await assertCanAddSavedRecipe(options);

  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    id: crypto.randomUUID(),
    createdAt: now,
    extraction: {
      fetchMode: sharedRecipe.fetchMode,
      provenance: sharedRecipe.provenance,
      strategy: sharedRecipe.strategy,
      warnings: sharedRecipe.warnings
    },
    notes: sharedRecipe.notes,
    recipe: {
      ...sharedRecipe.recipe,
      ingredients: sharedRecipe.recipe.ingredients.map((ingredient) => ({ ...ingredient })),
      steps: sharedRecipe.recipe.steps.map((step) => ({ ...step })),
      title: await getUniqueCopyTitle(sharedRecipe.recipe.title)
    },
    sourceHost: getSharedRecipeSourceHost(sharedRecipe),
    sourceUrl: sharedRecipe.recipe.sourceUrl,
    timesCooked: 0,
    sync: {
      status: "local_only"
    },
    updatedAt: now
  };

  return writeSavedRecipe(savedRecipe);
}

/**
 * The household payload for a saved recipe. Only domain fields travel: personal metadata
 * (favorites, tags, collections, ratings, cook log, …) and source images stay on this device.
 */
export const buildHouseholdRecipePayload = (recipe: WebSavedRecipe) => ({
  fetchMode: recipe.extraction.fetchMode,
  notes: recipe.notes ?? null,
  provenance: recipe.extraction.provenance,
  recipe: recipe.recipe,
  strategy: recipe.extraction.strategy,
  warnings: recipe.extraction.warnings
});

type SavedRecipeSyncState = NonNullable<WebSavedRecipe["sync"]>;

/**
 * Stores a new sync state on the recipe as it is stored *now*, in one transaction, so favorites,
 * tags, cooks and edits written during the network round trip are kept and a recipe deleted
 * meanwhile stays deleted. Never rewrites the (possibly multi-MB) source images. Returns the stored
 * recipe with its images, or `recipe` with the new state when it is gone.
 */
async function persistSyncState(
  recipe: WebSavedRecipe,
  nextSync: (existing: WebSavedRecipe) => SavedRecipeSyncState
): Promise<WebSavedRecipe> {
  const stored = await patchStoredRecipe(recipe.id, (existing) => ({
    ...existing,
    sync: nextSync(existing)
  }));

  if (!stored) {
    return { ...recipe, sync: nextSync(recipe) };
  }

  return (await hydrateImages(stored)) ?? stored;
}

/**
 * Shares a saved recipe with the household (or updates its household copy). It sends the recipe
 * as stored when called, not the caller's copy, which may predate an edit.
 */
export async function syncRecipeToHousehold(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  const db = await getDb();
  const stored = (await db.get(STORE_NAME, recipe.id)) as WebSavedRecipe | undefined;

  if (!stored) {
    throw new Error("This saved recipe is no longer available.");
  }

  const current = toSavedRecipeListRecord(stored);

  if (current.isStarter) {
    return persistSyncState(current, () => ({ status: "local_only" }));
  }

  try {
    const household = await apiClient.getHousehold();

    if (!household.household) {
      return persistSyncState(current, (existing) => ({
        ...(existing.sync || { status: "local_only" }),
        status: "local_only"
      }));
    }

    const sharedRecipeId = current.sync?.sharedRecipeId;
    const payload = buildHouseholdRecipePayload(current);

    const response = sharedRecipeId
      ? await apiClient.updateSharedRecipe(sharedRecipeId, payload)
      : await apiClient.createSharedRecipe({
          ...payload,
          sourceSavedRecipeId: current.id
        });

    return persistSyncState(current, (existing) => ({
      lastSyncedAt: response.recipe.updatedAt,
      sharedRecipeId: response.recipe.id,
      // Edited while the request was out: the household copy is already behind again.
      status: existing.updatedAt === current.updatedAt ? "synced" : "dirty"
    }));
  } catch (error) {
    return persistSyncState(current, (existing) => ({
      ...(existing.sync || { status: "local_only" }),
      lastError: error instanceof Error ? error.message : "Sync error",
      status: "sync_failed"
    }));
  }
}

/** Deletes a recipe together with its stored source images and any in-progress cook session. */
export async function deleteSavedRecipe(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_NAME, IMAGES_STORE_NAME, COOK_SESSIONS_STORE_NAME], "readwrite");

  await Promise.all([
    tx.objectStore(STORE_NAME).delete(id),
    tx.objectStore(IMAGES_STORE_NAME).delete(id),
    tx.objectStore(COOK_SESSIONS_STORE_NAME).delete(id),
    tx.done
  ]);

  emitDataChange({ topic: "savedRecipes", deletedIds: [id] });
  emitDataChange({ topic: "cookSessions", deletedIds: [id] });
}

export async function incrementSavedRecipeTimesCooked(
  id: string
): Promise<WebSavedRecipe | undefined> {
  const updated = await patchStoredRecipe(id, (existing) => ({
    ...existing,
    timesCooked: (existing.timesCooked ?? 0) + 1
  }));

  return hydrateImages(updated);
}

export async function updateSavedRecipeSync(
  id: string,
  syncData: Partial<NonNullable<WebSavedRecipe["sync"]>>
): Promise<void> {
  await patchStoredRecipe(id, (existing) => ({
    ...existing,
    sync: {
      ...(existing.sync || { status: "local_only" }),
      ...syncData
    }
  }));
}

/* ------------------------------------------------------------------------------------------------
 * Personal metadata (local-only; never changes updatedAt or the sync state)
 * ---------------------------------------------------------------------------------------------- */

/** Trims, collapses whitespace, drops empties and case-insensitive duplicates, caps count/length. */
export const normalizeRecipeTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const cleaned = tag.trim().replace(/\s+/gu, " ").slice(0, MAX_TAG_LENGTH).trim();
    const key = cleaned.toLowerCase();

    if (!cleaned || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(cleaned);

    if (normalized.length >= MAX_TAGS) {
      break;
    }
  }

  return normalized;
};

const withOptional = <Key extends WebSavedRecipeMetadataKey>(
  recipe: WebSavedRecipe,
  key: Key,
  value: WebSavedRecipe[Key] | undefined
): WebSavedRecipe => {
  const next = { ...recipe };

  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }

  return next;
};

export function setRecipeFavorite(
  id: string,
  favorite: boolean
): Promise<WebSavedRecipe | undefined> {
  return patchStoredRecipe(id, (existing) =>
    withOptional(existing, "favorite", favorite ? true : undefined)
  );
}

export function setRecipeTags(
  id: string,
  tags: readonly string[]
): Promise<WebSavedRecipe | undefined> {
  const normalized = normalizeRecipeTags(tags);
  return patchStoredRecipe(id, (existing) =>
    withOptional(existing, "tags", normalized.length ? normalized : undefined)
  );
}

export function setRecipeCollections(
  id: string,
  collectionIds: readonly string[]
): Promise<WebSavedRecipe | undefined> {
  const unique = Array.from(new Set(collectionIds.map((entry) => entry.trim()).filter(Boolean)));
  return patchStoredRecipe(id, (existing) =>
    withOptional(existing, "collectionIds", unique.length ? unique : undefined)
  );
}

export function setRecipeRating(
  id: string,
  rating: RecipeRating | null
): Promise<WebSavedRecipe | undefined> {
  if (rating !== null && ![1, 2, 3, 4, 5].includes(rating)) {
    return Promise.reject(new RangeError("Ratings go from 1 to 5."));
  }

  return patchStoredRecipe(id, (existing) => withOptional(existing, "rating", rating ?? undefined));
}

export function setRecipePreferredServings(
  id: string,
  servings: number | null
): Promise<WebSavedRecipe | undefined> {
  const value =
    servings !== null && Number.isFinite(servings) && servings > 0
      ? Math.round(servings * 100) / 100
      : undefined;
  return patchStoredRecipe(id, (existing) => withOptional(existing, "preferredServings", value));
}

/** Records a cook: bumps `timesCooked`, appends to `cookLog` and sets `lastCookedAt`. */
export function logRecipeCooked(
  id: string,
  entry: Partial<RecipeCookLogEntry> = {}
): Promise<WebSavedRecipe | undefined> {
  const cookedAt = entry.cookedAt ?? new Date().toISOString();
  const note = entry.note?.trim();
  const logEntry: RecipeCookLogEntry = { cookedAt, ...(note ? { note } : {}) };

  return patchStoredRecipe(id, (existing) => {
    const cookLog = [...(existing.cookLog ?? []), logEntry].slice(-MAX_COOK_LOG_ENTRIES);
    const lastCookedAt =
      existing.lastCookedAt && existing.lastCookedAt > cookedAt ? existing.lastCookedAt : cookedAt;

    return {
      ...existing,
      cookLog,
      lastCookedAt,
      timesCooked: (existing.timesCooked ?? 0) + 1
    };
  });
}

export function markRecipeOpened(
  id: string,
  openedAt: string = new Date().toISOString()
): Promise<WebSavedRecipe | undefined> {
  return patchStoredRecipe(id, (existing) => ({ ...existing, lastOpenedAt: openedAt }));
}

/** Removes a deleted collection from every recipe that referenced it. */
export async function removeCollectionFromAllRecipes(collectionId: string): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const recipes = (await store.getAll()) as WebSavedRecipe[];
  const updated: WebSavedRecipe[] = [];

  for (const recipe of recipes) {
    if (!recipe.collectionIds?.includes(collectionId)) {
      continue;
    }

    const remaining = recipe.collectionIds.filter((entry) => entry !== collectionId);
    const next = withOptional(recipe, "collectionIds", remaining.length ? remaining : undefined);
    await store.put(next);
    updated.push(toSavedRecipeListRecord(next));
  }

  await tx.done;

  if (updated.length) {
    emitDataChange({ topic: "savedRecipes", upserted: updated });
  }

  return updated.length;
}
