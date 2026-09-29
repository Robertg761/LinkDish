// The samples module directly: the package index would bring the whole domain engine (and zod)
// into the Cookbook's first download.
import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain/src/samples";

import { apiClient } from "../../api/client";
import { asAccount, isAccountChangedError } from "../../api/request-binding";
import { getCurrentAccount } from "../../auth/account-scope";
import { isCachedUserPremium } from "../../auth/auth-cache";
import { emitDataChange } from "../../data/change-feed";
import { discardCookSessionWrites } from "../../data/cook-session-write-guard";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";
import { runLinkDishTransaction } from "../../storage/idb-transaction";
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
import type { LinkDishTransaction } from "../../storage/idb-transaction";
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

/** Stored records as the cookbook lists them: list records (no scans), newest update first. */
export const toSavedRecipeList = (records: readonly WebSavedRecipe[]): WebSavedRecipe[] =>
  sortByUpdatedAtDesc(records.map(toSavedRecipeListRecord));

/** All saved recipes, newest update first. List records never include `sourceImages`. */
export async function getSavedRecipes(): Promise<WebSavedRecipe[]> {
  const db = await getDb();
  return toSavedRecipeList((await db.getAll(STORE_NAME)) as WebSavedRecipe[]);
}

/** Hostname for a recipe source, or "unknown" when the URL cannot be parsed. */
export const getSourceHost = (sourceUrl: string): string => {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "unknown";
  }
};

/** The parts of a `savedRecipes` or `recipeSourceImages` store (in a transaction) reads use. */
interface ReadableStore {
  get(key: string): Promise<unknown>;
}

/**
 * A recipe's stored record and its scans, read in one transaction so they are from the same
 * moment: a new version saved meanwhile (in this tab or another) is either both or neither.
 */
const readRecipeWithScans = (
  recipes: ReadableStore,
  imagesStore: ReadableStore,
  id: string
): Promise<[WebSavedRecipe | undefined, WebRecipeSourceImagesRecord | undefined]> =>
  Promise.all([
    recipes.get(id) as Promise<WebSavedRecipe | undefined>,
    imagesStore.get(id) as Promise<WebRecipeSourceImagesRecord | undefined>
  ]);

/** The record with its scans, as {@link getSavedRecipeById} returns it (`undefined` if none). */
const hydrateStoredRecipe = (
  stored: WebSavedRecipe | undefined,
  images: WebRecipeSourceImagesRecord | undefined
): WebSavedRecipe | undefined => {
  if (!stored) {
    return undefined;
  }

  const record = withStarterFlagById(stored);
  // Records written before the v4 migration ran still embed their images.
  return record.sourceImages?.length ? record : withImages(record, images?.images);
};

/** The original scans for an image-imported recipe (empty when there are none). */
export async function getSavedRecipeSourceImages(id: string): Promise<ExtractRecipeImage[]> {
  const [stored, images] = await runLinkDishTransaction(
    [STORE_NAME, IMAGES_STORE_NAME],
    "readonly",
    (tx) => readRecipeWithScans(tx.objectStore(STORE_NAME), tx.objectStore(IMAGES_STORE_NAME), id)
  );

  return images?.images?.length ? images.images : (stored?.sourceImages ?? []);
}

/** One saved recipe with its `sourceImages` hydrated (backward compatible detail read). */
export async function getSavedRecipeById(id: string): Promise<WebSavedRecipe | undefined> {
  const [stored, images] = await runLinkDishTransaction(
    [STORE_NAME, IMAGES_STORE_NAME],
    "readonly",
    (tx) => readRecipeWithScans(tx.objectStore(STORE_NAME), tx.objectStore(IMAGES_STORE_NAME), id)
  );

  return hydrateStoredRecipe(stored, images);
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
  const split = splitSourceImages(recipe);

  if (split.images === undefined) {
    await (await getDb()).put(STORE_NAME, split.record);
  } else {
    await runLinkDishTransaction([STORE_NAME, IMAGES_STORE_NAME], "readwrite", (tx) =>
      Promise.all(
        putSplitRecord(tx.objectStore(STORE_NAME), tx.objectStore(IMAGES_STORE_NAME), split)
      )
    );
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

const countPersonalRecipes = (keys: readonly IDBValidKey[]): number =>
  keys.filter((key) => !isStarterRecipeId(key)).length;

/**
 * Those of `collectionIds` whose collection still exists, read through the `collections` store of
 * the caller's transaction. A recipe written back (Undo) or copied after its collection was
 * deleted must not be filed in it again: the delete could not take it out.
 */
const keepExistingCollections = async (
  collections: ReadableStore,
  collectionIds: readonly string[]
): Promise<string[] | undefined> => {
  const found = await Promise.all(collectionIds.map((id) => collections.get(id)));
  const kept = collectionIds.filter((_, index) => found[index] !== undefined);
  return kept.length ? kept : undefined;
};

/** `record` filed only in `collectionIds` (none when `undefined`). */
const withCollectionIds = (
  record: WebSavedRecipe,
  collectionIds: string[] | undefined
): WebSavedRecipe => {
  const next: WebSavedRecipe = { ...record };

  if (collectionIds) {
    next.collectionIds = collectionIds;
  } else {
    delete next.collectionIds;
  }

  return next;
};

/**
 * Writes a recipe once `checks` pass. The checks read what is stored inside the readwrite
 * transaction that writes, so two tabs saving at once can't both pass them: the second finds the
 * recipe already there, or the free cookbook full. A recipe filed in collections (an Undo) is
 * only filed in those that still exist, read in the same transaction.
 */
async function writeNewSavedRecipe(
  recipe: WebSavedRecipe,
  checks: NewRecipeChecks
): Promise<NewRecipeOutcome> {
  const split = splitSourceImages(recipe);
  const filedIn = split.record.collectionIds?.length ? split.record.collectionIds : undefined;
  const outcome = await runLinkDishTransaction(
    filedIn
      ? [STORE_NAME, IMAGES_STORE_NAME, COLLECTIONS_STORE_NAME]
      : [STORE_NAME, IMAGES_STORE_NAME],
    "readwrite",
    async (tx): Promise<NewRecipeOutcome> => {
      const recipes = tx.objectStore(STORE_NAME);
      const stored = (await recipes.get(split.record.id)) as WebSavedRecipe | undefined;

      if (checks.ifAbsent && stored) {
        return { refused: "duplicate", stored: toSavedRecipeListRecord(stored) };
      }

      if (checks.withinFreeLimit && !stored && !isStarterRecipeId(split.record.id)) {
        if (countPersonalRecipes(await recipes.getAllKeys()) >= LOCAL_LIMIT_FREE) {
          return { refused: "limit_exceeded" };
        }
      }

      const record = filedIn
        ? withCollectionIds(
            split.record,
            await keepExistingCollections(tx.objectStore(COLLECTIONS_STORE_NAME), filedIn)
          )
        : split.record;

      await Promise.all(
        putSplitRecord(recipes, tx.objectStore(IMAGES_STORE_NAME), { ...split, record })
      );
      return { record };
    }
  );

  if (!outcome.refused) {
    emitDataChange({ topic: "savedRecipes", upserted: [outcome.record] });
  }

  return outcome;
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
  const { record, report } = await runLinkDishTransaction(
    whileCollectionExists
      ? [STORE_NAME, IMAGES_STORE_NAME, COLLECTIONS_STORE_NAME]
      : [STORE_NAME, IMAGES_STORE_NAME],
    "readwrite",
    async (tx) => {
      const recipes = tx.objectStore(STORE_NAME);
      const [existing, collection] = await Promise.all([
        recipes.get(id) as Promise<WebSavedRecipe | undefined>,
        whileCollectionExists
          ? (tx.objectStore(COLLECTIONS_STORE_NAME).get(whileCollectionExists) as Promise<unknown>)
          : undefined
      ]);
      const unchanged = () => existing && toSavedRecipeListRecord(existing);

      if (whileCollectionExists && collection === undefined) {
        // Nothing changed, but this tab may already show the change (optimistically): correct it.
        return { record: unchanged(), report: true };
      }

      const next = updater(existing);

      if (!next) {
        return { record: unchanged(), report: false };
      }

      const split = splitSourceImages(next);
      await Promise.all(putSplitRecord(recipes, tx.objectStore(IMAGES_STORE_NAME), split));
      return { record: split.record, report: true };
    }
  );

  if (report && record) {
    emitDataChange({ topic: "savedRecipes", upserted: [record] });
  }

  return record;
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
 *
 * When that recipe is gone by then (deleted in another tab), this saves a new recipe, which
 * counts against the free limit like any other save: SavedRecipeLimitError when the cookbook is
 * full (checked in the transaction that writes, see saveRecipe).
 */
export async function forceSaveRecipe(
  input: SaveRecipeInput,
  isPremiumUser: boolean
): Promise<WebSavedRecipe> {
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);
  const now = new Date().toISOString();
  const replace = (existing: WebSavedRecipe): WebSavedRecipe => {
    const existingSync = existing.sync;

    return {
      // Personal notes and metadata survive a re-import of the same recipe.
      ...toSavedRecipeListRecord(existing),
      id,
      recipe: input.recipe,
      sourceUrl: input.sourceUrl,
      sourceHost: getSourceHost(input.sourceUrl),
      createdAt: existing.createdAt,
      updatedAt: now,
      extraction: input.extraction,
      timesCooked: existing.timesCooked ?? 0,
      sync: existingSync?.sharedRecipeId
        ? {
            ...existingSync,
            status: "dirty"
          }
        : (existingSync ?? { status: "local_only" }),
      ...(input.sourceImages
        ? { sourceImages: input.sourceImages }
        : existing.sourceImages
          ? { sourceImages: existing.sourceImages }
          : {})
    };
  };

  // Twice at most: a recipe saved again under this id between the two writes is replaced.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await updateStoredRecipe(id, (existing) =>
      existing ? replace(existing) : undefined
    );

    if (stored) {
      return (await hydrateImages(stored)) ?? stored;
    }

    const saved = await saveRecipe(input, isPremiumUser);

    if (saved.success && saved.recipe) {
      return saved.recipe;
    }

    if (saved.error === "limit_exceeded") {
      throw new SavedRecipeLimitError();
    }
  }

  throw new Error("This recipe couldn't be saved.");
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

/**
 * "Soup" → "Soup (copy)", then "Soup (copy 2)", … skipping titles `countTitled` finds in the
 * cookbook.
 */
async function findUniqueCopyTitle(
  title: string,
  countTitled: (candidate: string) => Promise<number>
): Promise<string> {
  const base = title.replace(COPY_SUFFIX_PATTERN, "").trim() || title.trim();
  let candidate = `${base} (copy)`;

  for (let index = 2; index < 1000; index += 1) {
    if ((await countTitled(candidate)) === 0) {
      return candidate;
    }

    candidate = `${base} (copy ${index})`;
  }

  return candidate;
}

/** "Soup" → "Soup (copy)", then "Soup (copy 2)", … skipping titles already in the cookbook. */
export async function getUniqueCopyTitle(title: string): Promise<string> {
  const db = await getDb();
  return findUniqueCopyTitle(title, (candidate) =>
    db.countFromIndex(STORE_NAME, "title", candidate)
  );
}

/**
 * Copies a personal recipe. The copy is a regular personal recipe: it counts toward the free
 * limit (throws {@link SavedRecipeLimitError} when full), is never a starter, and is local-only.
 *
 * The recipe and its scans are read, and the copy (with its scans) written, in one readwrite
 * transaction: the copy is of one moment's recipe even when another tab saves a new version
 * meanwhile, a full device leaves neither the copy nor its scans, and the copy is only filed in
 * collections that still exist (another tab's delete of one waits for it, then takes it out).
 */
export async function duplicateSavedRecipe(
  id: string,
  options?: SavedRecipeQuotaOptions
): Promise<WebSavedRecipe | undefined> {
  const withinFreeLimit = !isPremium(options);
  const copied = await runLinkDishTransaction(
    [STORE_NAME, IMAGES_STORE_NAME, COLLECTIONS_STORE_NAME],
    "readwrite",
    async (tx) => {
      const recipes = tx.objectStore(STORE_NAME);
      const imagesStore = tx.objectStore(IMAGES_STORE_NAME);
      const existing = hydrateStoredRecipe(
        ...(await readRecipeWithScans(recipes, imagesStore, id))
      );

      if (!existing) {
        return undefined;
      }

      if (withinFreeLimit && countPersonalRecipes(await recipes.getAllKeys()) >= LOCAL_LIMIT_FREE) {
        throw new SavedRecipeLimitError();
      }

      const titleIndex = recipes.index("title");
      const title = await findUniqueCopyTitle(existing.recipe.title, (candidate) =>
        titleIndex.count(candidate)
      );
      const collectionIds = existing.collectionIds?.length
        ? await keepExistingCollections(
            tx.objectStore(COLLECTIONS_STORE_NAME),
            existing.collectionIds
          )
        : undefined;

      // A copy is a fresh personal recipe: it keeps content, notes, tags and collections, but not
      // starter status, sync state or this copy's own cooking history.
      const copyable: WebSavedRecipe = withCollectionIds(existing, collectionIds);
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
          title
        },
        createdAt: now,
        updatedAt: now,
        timesCooked: 0,
        sync: {
          status: "local_only"
        }
      };
      const split = splitSourceImages(duplicate);

      await Promise.all(putSplitRecord(recipes, imagesStore, split));
      return { duplicate, record: split.record };
    }
  );

  if (!copied) {
    return undefined;
  }

  emitDataChange({ topic: "savedRecipes", upserted: [copied.record] });
  return copied.duplicate;
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
      sharedBy: sharedRecipe.ownerUserId,
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

/** A Family copy as far as whose link it is goes: its id and the account that shared it. */
export type FamilyCopyOwner = Pick<SharedRecipe, "id" | "ownerUserId">;

/**
 * The Family copy `recipe` links to, when that link is `account`'s own: it shared it. Another
 * account's link on this device's cookbook is not this account's to update, unshare or delete.
 *
 * A link made before sharers were recorded is nobody's until `family` (the account's Family list,
 * when it has loaded) shows whose copy it is; `recordSharedLinkOwners` then stores that. Sharing
 * such a recipe again is safe either way: the API keys copies by sharer and saved recipe, so the
 * account that shared it gets its own copy back, updated, and any other account a copy of its own.
 */
export const getOwnSharedRecipeId = (
  recipe: Pick<WebSavedRecipe, "sync">,
  account: string | null,
  family: readonly FamilyCopyOwner[] | null = null
): string | undefined => {
  const sharedRecipeId = recipe.sync?.sharedRecipeId;

  if (!sharedRecipeId || !account) {
    return undefined;
  }

  const sharedBy =
    recipe.sync?.sharedBy ?? family?.find((copy) => copy.id === sharedRecipeId)?.ownerUserId;

  return sharedBy === account ? sharedRecipeId : undefined;
};

/** `recipe`'s sync state as `account` sees it (none when it is another account's link). */
const ownSyncOf = (
  recipe: Pick<WebSavedRecipe, "sync">,
  account: string | null
): WebSavedRecipe["sync"] =>
  !recipe.sync?.sharedRecipeId || getOwnSharedRecipeId(recipe, account) ? recipe.sync : undefined;

/**
 * `recipe` as signed-in `account` sees it: a Family link on it that isn't the account's (see
 * getOwnSharedRecipeId) reads as not shared. Signed out, it reads as stored (nothing can be shared
 * or unshared then).
 */
export const withOwnSharedLink = <Recipe extends Pick<WebSavedRecipe, "sync">>(
  recipe: Recipe,
  account: string | null,
  family: readonly FamilyCopyOwner[] | null = null
): Recipe =>
  account === null || !recipe.sync?.sharedRecipeId || getOwnSharedRecipeId(recipe, account, family)
    ? recipe
    : { ...recipe, sync: { status: "local_only" } };

/**
 * Stores who shared the Family copy each link made before sharers were recorded points to, as
 * `family` (an account's Family list) shows it, so those links read right without the list. Links
 * to copies it doesn't list stay nobody's. One transaction; changed recipes are reported.
 */
export async function recordSharedLinkOwners(family: readonly FamilyCopyOwner[]): Promise<void> {
  const owners = new Map(family.map((copy) => [copy.id, copy.ownerUserId]));

  if (owners.size === 0) {
    return;
  }

  const updated = await runLinkDishTransaction([STORE_NAME], "readwrite", async (tx) => {
    const recipes = tx.objectStore(STORE_NAME);
    const changed = ((await recipes.getAll()) as WebSavedRecipe[]).flatMap((recipe) => {
      const sync = recipe.sync;
      const owner =
        sync?.sharedRecipeId && sync.sharedBy === undefined
          ? owners.get(sync.sharedRecipeId)
          : undefined;

      return sync && owner ? [{ ...recipe, sync: { ...sync, sharedBy: owner } }] : [];
    });

    await Promise.all(changed.map((recipe) => recipes.put(recipe)));
    return changed.map(toSavedRecipeListRecord);
  });

  if (updated.length > 0) {
    emitDataChange({ topic: "savedRecipes", upserted: updated });
  }
}

/**
 * Shares a saved recipe with the household (or updates its household copy). It sends the recipe
 * as stored when called, not the caller's copy, which may predate an edit.
 *
 * `isCurrent` answers whether the account the share is for is still the one signed in: requests
 * carry whoever is signed in when they go out, so once someone else has signed in (or out) it
 * stops before its next request and hands back `recipe` as it was, never sharing into their
 * household or recording an answer meant for them.
 */
export async function syncRecipeToHousehold(
  recipe: WebSavedRecipe,
  options: { isCurrent?: (() => boolean) | undefined } = {}
): Promise<WebSavedRecipe> {
  const accountChanged = () => options.isCurrent?.() === false;
  // The share is sent only as the account signed in now (see asAccount).
  const sharingFor = getCurrentAccount();
  const db = await getDb();
  const stored = (await db.get(STORE_NAME, recipe.id)) as WebSavedRecipe | undefined;

  if (!stored) {
    throw new Error("This saved recipe is no longer available.");
  }

  const current = toSavedRecipeListRecord(stored);

  if (current.isStarter) {
    return persistSyncState(current, () => ({ status: "local_only" }));
  }

  if (accountChanged()) {
    return recipe;
  }

  try {
    const household = await apiClient.getHousehold();

    if (accountChanged()) {
      return recipe;
    }

    if (!household.household) {
      return persistSyncState(current, (existing) => ({
        ...(ownSyncOf(existing, sharingFor) ?? { status: "local_only" }),
        status: "local_only"
      }));
    }

    // Another account's link on this recipe isn't this one's to update: it shares its own copy.
    const sharedRecipeId = getOwnSharedRecipeId(current, sharingFor);
    const payload = buildHouseholdRecipePayload(current);

    const response = await asAccount(sharingFor, () =>
      sharedRecipeId
        ? apiClient.updateSharedRecipe(sharedRecipeId, payload)
        : apiClient.createSharedRecipe({
            ...payload,
            sourceSavedRecipeId: current.id
          })
    );

    // Someone else signed in (or out) while it was out: the share is in the last account's
    // household, which the account now signed in can't see or update, so it isn't recorded here.
    if (accountChanged()) {
      return recipe;
    }

    return persistSyncState(current, (existing) => ({
      lastSyncedAt: response.recipe.updatedAt,
      sharedBy: response.recipe.ownerUserId,
      sharedRecipeId: response.recipe.id,
      // Edited while the request was out: the household copy is already behind again.
      status: existing.updatedAt === current.updatedAt ? "synced" : "dirty"
    }));
  } catch (error) {
    // Failed as another account (or signed out), or not sent because one signed in: not this
    // recipe's failure to record.
    if (accountChanged() || isAccountChangedError(error)) {
      return recipe;
    }

    return persistSyncState(current, (existing) => ({
      ...(ownSyncOf(existing, sharingFor) ?? { status: "local_only" }),
      lastError: error instanceof Error ? error.message : "Sync error",
      status: "sync_failed"
    }));
  }
}

/** The stores a recipe's delete clears: the recipe, its scans and any in-progress cook session. */
const RECIPE_DELETE_STORES = [STORE_NAME, IMAGES_STORE_NAME, COOK_SESSIONS_STORE_NAME] as const;

const deleteRecipeRecords = (tx: LinkDishTransaction<"readwrite">, id: string) =>
  Promise.all(RECIPE_DELETE_STORES.map((name) => tx.objectStore(name).delete(id)));

/** Deletes the recipe, its scans and any cook session, in one transaction, reading none of them. */
const deleteRecipeUnread = (id: string): Promise<undefined> =>
  runLinkDishTransaction(RECIPE_DELETE_STORES, "readwrite", async (tx) => {
    await deleteRecipeRecords(tx, id);
    return undefined;
  });

/** The read of what a delete removes failed; the delete itself did not. */
class DeletedRecipeReadError extends Error {}

/**
 * Deletes the recipe and hands back what it removed, read in the same transaction. When that read
 * fails (Chrome can lose the file behind a large stored value, and then the scans can never be
 * read again: `NotReadableError`), the failed request aborts the transaction, so the recipe is
 * deleted again without the read and there is nothing to hand back.
 */
const deleteReadingSnapshot = async (id: string): Promise<WebSavedRecipe | undefined> => {
  try {
    return await runLinkDishTransaction(RECIPE_DELETE_STORES, "readwrite", async (tx) => {
      // Requests in a transaction run in order: the reads see the recipe the deletes remove.
      const read = (async () =>
        readRecipeWithScans(tx.objectStore(STORE_NAME), tx.objectStore(IMAGES_STORE_NAME), id))();
      const [[stored, images]] = await Promise.all([
        read.catch((error: unknown) => {
          throw new DeletedRecipeReadError("The recipe to delete could not be read.", {
            cause: error
          });
        }),
        deleteRecipeRecords(tx, id)
      ]);
      return hydrateStoredRecipe(stored, images);
    });
  } catch (error) {
    if (!(error instanceof DeletedRecipeReadError)) {
      throw error;
    }
  }

  return deleteRecipeUnread(id);
};

/**
 * Deletes a recipe together with its stored source images and any in-progress cook session, in
 * one transaction. Resolves with the recipe as it was when deleted (scans included, read in that
 * same transaction), for Undo to put back exactly that, or `undefined` when there was none or it
 * could not be read. Pass `snapshot: false` when nothing will be put back: the recipe and its
 * (possibly large) scans are then not read at all.
 */
export async function deleteSavedRecipe(
  id: string,
  { snapshot = true }: { snapshot?: boolean } = {}
): Promise<WebSavedRecipe | undefined> {
  // Cook-session changes this tab made for the recipe and hasn't saved yet would create its
  // session again after this delete: they are dropped.
  discardCookSessionWrites(id);
  const removed = snapshot ? await deleteReadingSnapshot(id) : await deleteRecipeUnread(id);

  emitDataChange({ topic: "savedRecipes", deletedIds: [id] });
  emitDataChange({ topic: "cookSessions", deletedIds: [id] });
  return removed;
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

/** The parts of a `savedRecipes` store (in the caller's readwrite transaction) a sweep uses. */
interface RecipeSweepStore {
  getAll(): Promise<unknown[]>;
  put(value: unknown): Promise<unknown>;
}

/**
 * Takes a collection out of every recipe filed in it, through the `savedRecipes` store of the
 * caller's readwrite transaction: the one that deletes the collection (see `deleteCollection`),
 * so the collection and its memberships go together or not at all. Returns the updated list
 * records, for the caller to report once that transaction has committed.
 */
export async function removeCollectionFromRecipes(
  recipes: RecipeSweepStore,
  collectionId: string
): Promise<WebSavedRecipe[]> {
  const updated = ((await recipes.getAll()) as WebSavedRecipe[]).flatMap((recipe) => {
    if (!recipe.collectionIds?.includes(collectionId)) {
      return [];
    }

    const remaining = recipe.collectionIds.filter((entry) => entry !== collectionId);
    return [withOptional(recipe, "collectionIds", remaining.length ? remaining : undefined)];
  });

  await Promise.all(updated.map((recipe) => recipes.put(recipe)));
  return updated.map(toSavedRecipeListRecord);
}
