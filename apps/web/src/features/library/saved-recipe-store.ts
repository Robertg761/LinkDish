// The samples module directly: the package index would bring the whole domain engine (and zod)
// into the Cookbook's first download.
import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain/src/samples";

import { apiClient } from "../../api/client";
import { isCachedUserPremium } from "../../auth/auth-cache";
import { emitDataChange } from "../../data/change-feed";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";
import {
  COLLECTIONS_STORE_NAME,
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

/** Characters of the images' data URLs: about the bytes they add to a JSON backup. */
export const measureSourceImageBytes = (images: readonly ExtractRecipeImage[]): number =>
  images.reduce((sum, image) => sum + (image.dataUrl?.length ?? 0), 0);

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
    delete withoutCount.sourceImageBytes;
    return { images: [], record: withoutCount };
  }

  return {
    images: sourceImages,
    record: {
      ...rest,
      sourceImageBytes: measureSourceImageBytes(sourceImages),
      sourceImageCount: sourceImages.length
    }
  };
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

const isPremium = (options?: SavedRecipeQuotaOptions): boolean =>
  options?.isPremiumUser ?? isCachedUserPremium();

/**
 * Throws {@link SavedRecipeLimitError} when a free user has no room for another recipe. An early
 * answer for the UI: writes check the limit again in the transaction that adds the recipe.
 */
export async function assertCanAddSavedRecipe(options?: SavedRecipeQuotaOptions): Promise<void> {
  if (isPremium(options)) {
    return;
  }

  if ((await countQuotaSavedRecipes()) >= LOCAL_LIMIT_FREE) {
    throw new SavedRecipeLimitError();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------------------------------- */

interface RecordStore {
  delete(key: string): Promise<unknown>;
  put(value: unknown): Promise<unknown>;
}

/** Queues the writes of a record and of its images (see {@link SplitRecord}) in a transaction. */
const putSplitRecord = (
  recipes: RecordStore,
  imagesStore: RecordStore,
  { images, record }: SplitRecord
): Array<Promise<unknown>> => [
  recipes.put(record),
  ...(images === undefined
    ? []
    : [
        images.length
          ? imagesStore.put(imagesRecordFor(record.id, images, record.updatedAt))
          : imagesStore.delete(record.id)
      ])
];

/** Writes the record and its images atomically; returns the stored (image-free) record. */
async function writeSavedRecipe(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  const db = await getDb();
  const split = splitSourceImages(recipe);

  if (split.images === undefined) {
    await db.put(STORE_NAME, split.record);
  } else {
    const tx = db.transaction([STORE_NAME, IMAGES_STORE_NAME], "readwrite");

    await Promise.all([
      ...putSplitRecord(tx.objectStore(STORE_NAME), tx.objectStore(IMAGES_STORE_NAME), split),
      tx.done
    ]);
  }

  emitDataChange({ topic: "savedRecipes", upserted: [split.record] });
  return split.record;
}

interface NewRecipeChecks {
  /** Write nothing when a recipe with this id is already stored. */
  ifAbsent?: boolean | undefined;
  /**
   * Write nothing when the recipe would be one personal recipe too many for a free cookbook
   * ({@link LOCAL_LIMIT_FREE}). Starters, and a recipe that is already stored, always fit.
   */
  withinFreeLimit?: boolean | undefined;
}

type NewRecipeOutcome =
  | { record: WebSavedRecipe; refused?: undefined }
  /** `stored` is the record already there (image-free), left as it was. */
  | { record?: undefined; refused: "duplicate"; stored: WebSavedRecipe }
  | { record?: undefined; refused: "limit_exceeded" };

/**
 * Writes a recipe once `checks` pass. The checks read what is stored inside the readwrite
 * transaction that writes, so two tabs saving at once can't both pass them: the second finds the
 * recipe already there, or the free cookbook full.
 */
async function writeNewSavedRecipe(
  recipe: WebSavedRecipe,
  checks: NewRecipeChecks
): Promise<NewRecipeOutcome> {
  const db = await getDb();
  const split = splitSourceImages(recipe);
  const tx = db.transaction([STORE_NAME, IMAGES_STORE_NAME], "readwrite");
  const done = tx.done;
  // A failed request rejects below; keep `done` from also surfacing as an unhandled rejection.
  done.catch(() => undefined);
  const recipes = tx.objectStore(STORE_NAME);
  const stored = (await recipes.get(split.record.id)) as WebSavedRecipe | undefined;

  if (checks.ifAbsent && stored) {
    await done;
    return { refused: "duplicate", stored: toSavedRecipeListRecord(stored) };
  }

  if (checks.withinFreeLimit && !stored && !isStarterRecipeId(split.record.id)) {
    const keys = await recipes.getAllKeys();

    if (keys.filter((key) => !isStarterRecipeId(key)).length >= LOCAL_LIMIT_FREE) {
      await done;
      return { refused: "limit_exceeded" };
    }
  }

  await Promise.all([...putSplitRecord(recipes, tx.objectStore(IMAGES_STORE_NAME), split), done]);
  emitDataChange({ topic: "savedRecipes", upserted: [split.record] });
  return { record: split.record };
}

/**
 * Writes a recipe unless it would be one personal recipe too many for a free cookbook, in which
 * case it throws {@link SavedRecipeLimitError}. Returns the stored (image-free) record.
 */
async function writeWithinFreeLimit(
  recipe: WebSavedRecipe,
  options?: SavedRecipeQuotaOptions
): Promise<WebSavedRecipe> {
  const outcome = await writeNewSavedRecipe(recipe, { withinFreeLimit: !isPremium(options) });

  if (outcome.refused) {
    throw new SavedRecipeLimitError();
  }

  return outcome.record;
}

interface StoredRecipeUpdateOptions {
  /**
   * Change nothing unless this collection still exists. It is read in the same transaction, so
   * when another tab deletes the collection, that delete either lands first (and the recipe is
   * not added to it) or after (and takes the recipe out of it again).
   */
  whileCollectionExists?: string | undefined;
}

/**
 * Read-modify-write of one stored record in a single readwrite transaction, so updates from this
 * tab and others never overwrite each other. `updater` gets the stored record (`undefined` when
 * there is none) and returns the record to store, or `undefined` to leave things as they are. It
 * must be synchronous: awaiting anything else would let the transaction commit before the write.
 * Returns the stored (image-free) record, `undefined` when there is none.
 */
async function updateStoredRecipe(
  id: string,
  updater: (existing: WebSavedRecipe | undefined) => WebSavedRecipe | undefined,
  { whileCollectionExists }: StoredRecipeUpdateOptions = {}
): Promise<WebSavedRecipe | undefined> {
  const db = await getDb();
  const tx = db.transaction(
    whileCollectionExists
      ? [STORE_NAME, IMAGES_STORE_NAME, COLLECTIONS_STORE_NAME]
      : [STORE_NAME, IMAGES_STORE_NAME],
    "readwrite"
  );
  const done = tx.done;
  // A failed request rejects below; keep `done` from also surfacing as an unhandled rejection.
  done.catch(() => undefined);
  const recipes = tx.objectStore(STORE_NAME);
  const [existing, collection] = await Promise.all([
    recipes.get(id) as Promise<WebSavedRecipe | undefined>,
    whileCollectionExists
      ? (tx.objectStore(COLLECTIONS_STORE_NAME).get(whileCollectionExists) as Promise<unknown>)
      : undefined
  ]);

  if (whileCollectionExists && collection === undefined) {
    await done;

    if (!existing) {
      return undefined;
    }

    // Nothing changed, but this tab may already show the change (optimistically): correct it.
    const unchanged = toSavedRecipeListRecord(existing);
    emitDataChange({ topic: "savedRecipes", upserted: [unchanged] });
    return unchanged;
  }

  const next = updater(existing);

  if (!next) {
    await done;
    return existing && toSavedRecipeListRecord(existing);
  }

  const split = splitSourceImages(next);
  await Promise.all([...putSplitRecord(recipes, tx.objectStore(IMAGES_STORE_NAME), split), done]);
  emitDataChange({ topic: "savedRecipes", upserted: [split.record] });
  return split.record;
}

/** {@link updateStoredRecipe} for a recipe that must already be stored (nothing is created). */
const patchStoredRecipe = (
  id: string,
  updater: (existing: WebSavedRecipe) => WebSavedRecipe,
  options?: StoredRecipeUpdateOptions
): Promise<WebSavedRecipe | undefined> =>
  updateStoredRecipe(id, (existing) => existing && updater(existing), options);

const hydrateImages = async (record: WebSavedRecipe | undefined) => {
  if (!record?.sourceImageCount) {
    return record;
  }

  return withImages(record, await getSavedRecipeSourceImages(record.id));
};

/**
 * True once this browser's cookbook has been set up (starter recipes seeded, or recipes found).
 * False on a first visit, when the Cookbook will greet a new cook.
 */
export const hasSeededStarterRecipes = (): boolean =>
  safeGetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY) === "true";

/**
 * Seeds the starter recipes into an empty cookbook (a first visit) and returns what it wrote;
 * null when there was nothing to do. The starters (~2 KB) ship with the store, and the check and
 * the writes are one transaction with no waits in between: on a slow phone every step waits for
 * the main thread, and the first visit's Cookbook shows as soon as storage answers.
 */
async function seedStarterRecipes(): Promise<WebSavedRecipe[] | null> {
  if (typeof window === "undefined" || hasSeededStarterRecipes()) {
    return null;
  }

  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  if ((await store.count()) > 0) {
    await tx.done;
    safeSetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
    return null;
  }

  const seeded = createStarterRecipeSeedRecords().map(
    (starterRecipe): WebSavedRecipe => ({
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
    })
  );

  await Promise.all([...seeded.map((recipe) => store.put(recipe)), tx.done]);

  // Only mark the library as seeded once every starter recipe is written, so a
  // failure part-way through can be retried on the next launch.
  safeSetItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");
  emitDataChange({ topic: "savedRecipes", upserted: seeded });
  return seeded;
}

export async function seedStarterRecipesIfNeeded(): Promise<void> {
  await seedStarterRecipes();
}

/** IndexedDB key order, which `getAll` returns records in. */
const byId = (left: WebSavedRecipe, right: WebSavedRecipe): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

/**
 * The cookbook's first read ({@link getSavedRecipes} list records, newest first). On a first
 * visit it seeds the starter recipes and returns them as written, without reading them back.
 */
export async function loadCookbookRecipes(): Promise<WebSavedRecipe[]> {
  const seeded = await seedStarterRecipes();

  return seeded
    ? sortByUpdatedAtDesc([...seeded].sort(byId).map(toSavedRecipeListRecord))
    : getSavedRecipes();
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
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);
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

  // The duplicate check and the free limit read what is stored in the transaction that writes.
  const outcome = await writeNewSavedRecipe(savedRecipe, {
    ifAbsent: true,
    withinFreeLimit: !isPremiumUser
  });

  if (outcome.refused) {
    // A duplicate lets the cook choose to replace it (forceSaveRecipe).
    return {
      success: false,
      error: outcome.refused === "duplicate" ? "duplicate_prompt" : "limit_exceeded"
    };
  }

  return { success: true, recipe: withImages(outcome.record, input.sourceImages) };
}

/**
 * Saves the recipe over the stored one with the same id (a re-import), keeping its personal notes
 * and metadata. Merged with the record as stored inside one readwrite transaction, so a favorite,
 * tag or cook another tab saves meanwhile is kept.
 */
export async function forceSaveRecipe(input: SaveRecipeInput): Promise<WebSavedRecipe> {
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);
  const now = new Date().toISOString();
  const stored = await updateStoredRecipe(id, (existing): WebSavedRecipe => {
    const existingSync = existing?.sync;

    return {
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
  });

  if (!stored) {
    // Unreachable: the updater always returns a record to write.
    throw new Error("This recipe couldn't be saved.");
  }

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

export interface RestoredSavedRecipe {
  /** The recipe as stored now (without its scans). */
  recipe: WebSavedRecipe;
  /**
   * False when the recipe was already back (saved again since the delete, say in another tab):
   * that record, with its own edits and scans, stays as it is.
   */
  restored: boolean;
}

/**
 * Puts a deleted recipe (and its scans) back for Undo, unless a recipe with its id is stored
 * again by now: that newer record is kept, never replaced by the older snapshot. When a free
 * cookbook filled up again after the delete there is no room for it, so this throws
 * {@link SavedRecipeLimitError} instead of going past the limit. Starters always fit. Both checks
 * read what is stored in the transaction that writes, so a save in another tab can't slip in
 * between them and the write.
 */
export async function restoreSavedRecipe(
  recipe: WebSavedRecipe,
  options?: SavedRecipeQuotaOptions
): Promise<RestoredSavedRecipe> {
  const outcome = await writeNewSavedRecipe(recipe, {
    ifAbsent: true,
    withinFreeLimit: !isPremium(options)
  });

  if (outcome.refused === "limit_exceeded") {
    throw new SavedRecipeLimitError();
  }

  if (outcome.refused === "duplicate") {
    // This tab may still show the recipe as deleted: show the stored one.
    emitDataChange({ topic: "savedRecipes", upserted: [outcome.stored] });
    return { recipe: outcome.stored, restored: false };
  }

  return { recipe: outcome.record, restored: true };
}

/** An edit from the recipe editor: only what the cook changed. */
export interface SavedRecipeEdit {
  /** New notes (`null` or blank clears them). Left out, the stored notes stay. */
  notes?: string | null | undefined;
  /** The recipe fields the cook changed; the others stay as stored. */
  recipe?: Partial<Recipe> | undefined;
  /** A new source link. */
  sourceUrl?: string | undefined;
}

/**
 * Saves an edit of the recipe (and, with `sourceUrl`, its link) in one read-modify-write that
 * changes only what `edit` holds, so a note or recipe edit another tab saved meanwhile (or a
 * cook, a favorite) is kept. An edit that holds nothing writes nothing.
 */
export async function updateSavedRecipe(
  id: string,
  edit: SavedRecipeEdit
): Promise<WebSavedRecipe | undefined> {
  const { notes, recipe, sourceUrl } = edit;
  const recipeChanges = recipe && Object.keys(recipe).length > 0 ? recipe : undefined;
  const updated = await updateStoredRecipe(id, (existing) => {
    if (!existing || (notes === undefined && !recipeChanges && !sourceUrl)) {
      return undefined;
    }

    const next: WebSavedRecipe = {
      ...existing,
      ...(recipeChanges ? { recipe: { ...existing.recipe, ...recipeChanges } } : {}),
      ...(sourceUrl ? { sourceHost: getSourceHost(sourceUrl), sourceUrl } : {}),
      updatedAt: new Date().toISOString(),
      sync: {
        ...(existing.sync || { status: "local_only" }),
        status: existing.sync?.sharedRecipeId ? "dirty" : (existing.sync?.status ?? "local_only")
      }
    };

    if (notes !== undefined) {
      const trimmed = notes?.trim();

      if (trimmed) {
        next.notes = trimmed;
      } else {
        delete next.notes;
      }
    }

    return next;
  });

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

  await writeWithinFreeLimit(duplicate, options);
  return duplicate;
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

  return writeWithinFreeLimit(savedRecipe, options);
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

/** New tags, or how to change the stored ones (e.g. add one: `(tags) => [...tags, "Quick"]`). */
export type RecipeTagsUpdate =
  | readonly string[]
  | ((current: readonly string[]) => readonly string[]);

/**
 * Sets the recipe's tags. Pass a function to change the tags as stored when the write happens
 * (inside its transaction) rather than a list read earlier, so a tag another tab adds meanwhile
 * is kept. The function must be synchronous.
 */
export function setRecipeTags(
  id: string,
  tags: RecipeTagsUpdate
): Promise<WebSavedRecipe | undefined> {
  return patchStoredRecipe(id, (existing) => {
    const normalized = normalizeRecipeTags(
      typeof tags === "function" ? tags(existing.tags ?? []) : tags
    );
    return withOptional(existing, "tags", normalized.length ? normalized : undefined);
  });
}

const uniqueCollectionIds = (collectionIds: readonly string[]): string[] =>
  Array.from(new Set(collectionIds.map((entry) => entry.trim()).filter(Boolean)));

export function setRecipeCollections(
  id: string,
  collectionIds: readonly string[]
): Promise<WebSavedRecipe | undefined> {
  const unique = uniqueCollectionIds(collectionIds);
  return patchStoredRecipe(id, (existing) =>
    withOptional(existing, "collectionIds", unique.length ? unique : undefined)
  );
}

/**
 * Adds the recipe to a collection (or, with `member: false`, takes it out) as stored when the
 * write happens, so a membership another tab changes meanwhile is kept. Adding does nothing when
 * the collection no longer exists (another tab deleted it).
 */
export function setRecipeCollectionMembership(
  id: string,
  collectionId: string,
  member: boolean
): Promise<WebSavedRecipe | undefined> {
  return patchStoredRecipe(
    id,
    (existing) => {
      const current = existing.collectionIds ?? [];
      const next = uniqueCollectionIds(
        member ? [...current, collectionId] : current.filter((entry) => entry !== collectionId)
      );
      return withOptional(existing, "collectionIds", next.length ? next : undefined);
    },
    member ? { whileCollectionExists: collectionId } : {}
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
