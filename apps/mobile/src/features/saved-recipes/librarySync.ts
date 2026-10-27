/**
 * Cloud sync of the signed-in account's cookbook on this device: the same engine as the web app
 * (`runLibrarySync` in @linkdish/recipe-domain) over the in-memory cookbook, with its bookkeeping
 * in AsyncStorage.
 *
 * - The cookbook on a device is linked to one account: the first to sign in on it (the two
 *   cookbooks are merged). Signing out keeps it; another account that signs in never syncs it,
 *   and can replace it with its own (see {@link replaceMobileLibrary}).
 * - Tags and collection membership live on the record as `libraryExtras`, with the fields this
 *   app doesn't show yet (ratings, the cook log, preferred servings), so those sync through
 *   untouched instead of being deleted. Collections are the cookbook's own list (see
 *   ./collections); builds before collections came to Android kept them in the sync state, and
 *   the first sync moves them over.
 */
import { createLibrarySyncTransport } from "@linkdish/api-client/src/library-sync";
import {
  fingerprintKey,
  fingerprintPayload,
  librarySyncGroupsFor,
  librarySyncKey,
  runLibrarySync,
  stableStringify
} from "@linkdish/recipe-domain/src/library-sync";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { fromLibraryCollection, toLibraryCollection, type MobileCollection } from "./collections";

import type { SavedRecipeLibraryExtras, SavedRecipeRecord } from "./store";
import type { ExtractorApiClient } from "@linkdish/api-client";
import type { LibraryCollection, LibraryRecipe } from "@linkdish/api-contracts";
import type {
  LibraryItemKind,
  LibraryLocalWrite,
  LibrarySyncAdapter,
  LibrarySyncBase,
  LibrarySyncPayload
} from "@linkdish/recipe-domain/src/library-sync";

export const LIBRARY_SYNC_STORAGE_KEY = "linkdish.librarySync.v1";

const MAX_NOTES_LENGTH = 20_000;
const MAX_ITEM_ID_LENGTH = 180;

interface StoredCollection {
  payload: LibraryCollection;
  updatedAt: string;
}

/** What is stored under {@link LIBRARY_SYNC_STORAGE_KEY}. */
export interface MobileLibrarySyncState {
  account: string;
  cursor: string;
  linkedAt: string;
  bases: Record<string, LibrarySyncBase>;
  /**
   * Collections as builds before collections came to Android kept them. The first sync moves them
   * into the cookbook's list and leaves this out.
   */
  collections?: Record<string, StoredCollection> | undefined;
}

const isState = (value: unknown): value is MobileLibrarySyncState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { account?: unknown }).account === "string" &&
  typeof (value as { cursor?: unknown }).cursor === "string" &&
  typeof (value as { bases?: unknown }).bases === "object";

export const readMobileLibrarySyncState = async (): Promise<MobileLibrarySyncState | null> => {
  const stored = await AsyncStorage.getItem(LIBRARY_SYNC_STORAGE_KEY);

  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Collections an older build kept in the sync state that a sync hasn't moved into the cookbook
 * yet (see moveStateCollections). The cookbook loads them too, so they're there signed out.
 */
export const readStateCollections = async (): Promise<MobileCollection[]> => {
  const state = await readMobileLibrarySyncState();

  return Object.entries(state?.collections ?? {}).map(([id, stored]) =>
    fromLibraryCollection(id, stored.payload, stored.updatedAt)
  );
};

const writeState = (state: MobileLibrarySyncState): Promise<void> =>
  AsyncStorage.setItem(LIBRARY_SYNC_STORAGE_KEY, JSON.stringify(state));

/**
 * After the cookbook's stored collections were found damaged (and copied aside), sync forgets what
 * it knew of them and pulls everything afresh: the cloud's collections come back here instead of
 * their absence going out as deletions.
 */
export const forgetSyncedCollections = async (): Promise<void> => {
  const state = await readMobileLibrarySyncState();

  if (!state) {
    return;
  }

  const prefix = librarySyncKey("collection", "");

  for (const key of Object.keys(state.bases)) {
    if (key.startsWith(prefix)) {
      delete state.bases[key];
    }
  }

  state.cursor = "0";
  await writeState(state);
};

/** Takes the collections an older build kept out of the sync state, once the cookbook saved them. */
export const clearStateCollections = async (): Promise<void> => {
  const state = await readMobileLibrarySyncState();

  if (state?.collections) {
    delete state.collections;
    await writeState(state);
  }
};

const newState = (account: string): MobileLibrarySyncState => ({
  account,
  bases: {},
  cursor: "0",
  linkedAt: new Date().toISOString()
});

/** Forgets the link when `account` is the one linked (its cloud cookbook was deleted). */
export const unlinkMobileLibrary = async (account: string): Promise<void> => {
  if ((await readMobileLibrarySyncState())?.account === account) {
    await AsyncStorage.removeItem(LIBRARY_SYNC_STORAGE_KEY);
  }
};

/* ------------------------------------------------------------------------------------------------
 * Records as library items
 * ---------------------------------------------------------------------------------------------- */

const LIBRARY_EXTRA_KEYS = [
  "tags",
  "collectionIds",
  "rating",
  "cookLog",
  "lastCookedAt",
  "preferredServings"
] as const satisfies ReadonlyArray<keyof SavedRecipeLibraryExtras>;

/** Starters stay on the device; every other saved recipe syncs. */
export const isSyncedRecord = (record: Pick<SavedRecipeRecord, "id" | "isStarter">): boolean =>
  !record.isStarter && record.id.length <= MAX_ITEM_ID_LENGTH;

const extrasOf = (
  source: SavedRecipeLibraryExtras | undefined
): SavedRecipeLibraryExtras | undefined => {
  const extras: Record<string, unknown> = {};

  for (const key of LIBRARY_EXTRA_KEYS) {
    const value = source?.[key];

    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      extras[key] = value;
    }
  }

  return Object.keys(extras).length ? extras : undefined;
};

/** A saved recipe as the cloud keeps it. Empty and default values are left out. */
export const toLibraryRecipe = (record: SavedRecipeRecord): LibraryRecipe => {
  const notes = record.notes?.trim().slice(0, MAX_NOTES_LENGTH);

  return {
    createdAt: record.savedAt,
    fetchMode: record.fetchMode,
    provenance: record.provenance as LibraryRecipe["provenance"],
    recipe: record.recipe,
    strategy: record.strategy as LibraryRecipe["strategy"],
    warnings: record.warnings,
    ...(notes ? { notes } : {}),
    ...(record.clonedFromId ? { clonedFromId: record.clonedFromId } : {}),
    ...(record.favorite ? { favorite: true } : {}),
    ...(record.timesCooked ? { timesCooked: record.timesCooked } : {}),
    ...extrasOf(record.libraryExtras)
  };
};

const laterOf = (left: string, right: string): string => (left > right ? left : right);

/**
 * The record to keep for a recipe from the cloud (or merged with it): `existing` (`undefined` for
 * a new one) with the cloud's fields; its scans and Family link stay as they are here. An edit to
 * the recipe or its notes counts as an update, as an edit here does.
 */
export const fromLibraryRecipe = (
  existing: SavedRecipeRecord | undefined,
  id: string,
  item: LibraryRecipe,
  updatedAt: string
): SavedRecipeRecord => {
  const edited =
    !existing ||
    stableStringify(existing.recipe) !== stableStringify(item.recipe) ||
    (existing.notes?.trim() || undefined) !== item.notes;
  const extras = extrasOf(item);

  return {
    ...existing,
    clonedFromId: item.clonedFromId,
    favorite: item.favorite ? true : undefined,
    fetchMode: item.fetchMode,
    id,
    libraryExtras: extras,
    notes: item.notes,
    provenance: item.provenance,
    recipe: item.recipe,
    savedAt: item.createdAt,
    strategy: item.strategy,
    timesCooked: item.timesCooked ?? 0,
    updatedAt: !existing
      ? updatedAt
      : edited
        ? laterOf(existing.updatedAt ?? existing.savedAt, updatedAt)
        : existing.updatedAt,
    warnings: item.warnings
  };
};

const recipeItem = (record: SavedRecipeRecord) => ({
  id: record.id,
  kind: "recipe" as const,
  payload: toLibraryRecipe(record) as unknown as LibrarySyncPayload
});

const fingerprintKeyOf = (kind: LibraryItemKind, payload: LibrarySyncPayload): string =>
  fingerprintKey(fingerprintPayload(payload, librarySyncGroupsFor(kind)));

const readLocalItems = (
  records: readonly SavedRecipeRecord[],
  collections: readonly MobileCollection[]
) => {
  const items = new Map<
    string,
    { kind: LibraryItemKind; id: string; payload: LibrarySyncPayload }
  >();

  for (const record of records) {
    if (isSyncedRecord(record)) {
      items.set(librarySyncKey("recipe", record.id), recipeItem(record));
    }
  }

  for (const collection of collections) {
    if (collection.id.length <= MAX_ITEM_ID_LENGTH) {
      items.set(librarySyncKey("collection", collection.id), {
        id: collection.id,
        kind: "collection",
        payload: toLibraryCollection(collection)
      });
    }
  }

  return items;
};

/* ------------------------------------------------------------------------------------------------
 * A sync run
 * ---------------------------------------------------------------------------------------------- */

/** The cookbook as the provider holds it. */
export interface MobileLibraryCookbook {
  getRecords(): SavedRecipeRecord[];
  /** Changes the cookbook (synchronously, like every other cookbook change). */
  commitRecords(update: (records: SavedRecipeRecord[]) => SavedRecipeRecord[]): void;
  getCollections(): MobileCollection[];
  /** Changes the cookbook's collections (synchronously). */
  commitCollections(update: (collections: MobileCollection[]) => MobileCollection[]): void;
  /**
   * Stores the cookbook and its collections now (before the sync records that the cloud's copy
   * is in them), and lets go of scans only `removed` used.
   */
  persist(removed: readonly SavedRecipeRecord[]): Promise<void>;
}

export interface MobileLibrarySyncOptions {
  account: string;
  client: Pick<ExtractorApiClient, "pullLibraryChanges" | "pushLibraryChanges">;
  cookbook: MobileLibraryCookbook;
  /** Whether `account` is still the one signed in: the run stops before its next step if not. */
  isCurrent: () => boolean;
}

export type MobileLibrarySyncOutcome =
  | { status: "synced"; held: number }
  /** The cookbook on this device is linked to another account: nothing was synced. */
  | { status: "other_account" };

const applyRecipeWrites = (
  cookbook: MobileLibraryCookbook,
  writes: readonly LibraryLocalWrite[],
  written: Set<string>
): SavedRecipeRecord[] => {
  const removed: SavedRecipeRecord[] = [];

  if (writes.length === 0) {
    return removed;
  }

  cookbook.commitRecords((records) => {
    const byId = new Map(records.map((record) => [record.id, record]));
    const added: SavedRecipeRecord[] = [];

    for (const write of writes) {
      const stored = byId.get(write.id);

      if (
        (stored && !isSyncedRecord(stored)) ||
        (stored ? fingerprintKeyOf("recipe", recipeItem(stored).payload) : null) !==
          write.expectedKey
      ) {
        continue;
      }

      if (write.payload) {
        const next = fromLibraryRecipe(
          stored,
          write.id,
          write.payload as unknown as LibraryRecipe,
          write.updatedAt
        );
        byId.set(write.id, next);

        if (!stored) {
          added.push(next);
        }
      } else if (stored) {
        byId.delete(write.id);
        removed.push(stored);
      }

      written.add(librarySyncKey("recipe", write.id));
    }

    // New recipes go first, newest first, as a save does.
    const kept = records.flatMap((record) => {
      const next = byId.get(record.id);
      return next ? [next] : [];
    });
    added.sort((left, right) => (left.savedAt < right.savedAt ? 1 : -1));
    return [...added, ...kept];
  });

  return removed;
};

const collectionKeyOf = (collection: MobileCollection): string =>
  fingerprintKeyOf("collection", toLibraryCollection(collection));

const applyCollectionWrites = (
  cookbook: MobileLibraryCookbook,
  writes: readonly LibraryLocalWrite[],
  written: Set<string>
) => {
  if (writes.length === 0) {
    return;
  }

  cookbook.commitCollections((collections) => {
    const byId = new Map(collections.map((collection) => [collection.id, collection]));

    for (const write of writes) {
      const stored = byId.get(write.id);

      if ((stored ? collectionKeyOf(stored) : null) !== write.expectedKey) {
        continue;
      }

      if (write.payload) {
        byId.set(
          write.id,
          fromLibraryCollection(
            write.id,
            write.payload as unknown as LibraryCollection,
            write.updatedAt
          )
        );
      } else {
        byId.delete(write.id);
      }

      written.add(librarySyncKey("collection", write.id));
    }

    return [...byId.values()];
  });
};

/**
 * Moves collections kept in the sync state by builds before collections came to Android into the
 * cookbook's list (one already there stays as it is), then drops them from the state.
 */
const moveStateCollections = async (
  state: MobileLibrarySyncState,
  cookbook: MobileLibraryCookbook
): Promise<void> => {
  const legacy = Object.entries(state.collections ?? {});

  if (legacy.length > 0) {
    cookbook.commitCollections((collections) => {
      const known = new Set(collections.map((collection) => collection.id));
      return [
        ...collections,
        ...legacy
          .filter(([id]) => !known.has(id))
          .map(([id, stored]) => fromLibraryCollection(id, stored.payload, stored.updatedAt))
      ];
    });
    await cookbook.persist([]);
  }

  if (state.collections) {
    delete state.collections;
    await writeState(state);
  }
};

/** One sync run for `account` (linking an unlinked cookbook to it first). */
export const syncMobileLibrary = async ({
  account,
  client,
  cookbook,
  isCurrent
}: MobileLibrarySyncOptions): Promise<MobileLibrarySyncOutcome> => {
  let state = await readMobileLibrarySyncState();

  if (!state) {
    state = newState(account);
    await writeState(state);
  }

  if (state.account !== account) {
    return { status: "other_account" };
  }

  const linked = state;
  await moveStateCollections(linked, cookbook);
  const adapter: LibrarySyncAdapter = {
    ...createLibrarySyncTransport(client),
    applyLocal: async (writes) => {
      const written = new Set<string>();
      const removed = applyRecipeWrites(
        cookbook,
        writes.filter((write) => write.kind === "recipe"),
        written
      );
      applyCollectionWrites(
        cookbook,
        writes.filter((write) => write.kind === "collection"),
        written
      );

      if (written.size > 0) {
        await cookbook.persist(removed);
      }

      return written;
    },
    isCurrent,
    readLocal: () =>
      Promise.resolve(readLocalItems(cookbook.getRecords(), cookbook.getCollections())),
    readState: () =>
      Promise.resolve({ bases: new Map(Object.entries(linked.bases)), cursor: linked.cursor }),
    saveState: async (cursor, bases) => {
      if (cursor !== null) {
        linked.cursor = cursor;
      }

      for (const [key, base] of bases) {
        if (base) {
          linked.bases[key] = base;
        } else {
          delete linked.bases[key];
        }
      }

      await writeState(linked);
    }
  };

  await runLibrarySync(adapter);

  return {
    held: Object.values(linked.bases).filter((base) => base.heldKey).length,
    status: "synced"
  };
};

/** Changes made here that the account the cookbook is linked to doesn't have yet. */
export const countMobileChangesNotSynced = async (
  records: readonly SavedRecipeRecord[],
  collections: readonly MobileCollection[]
): Promise<number> => {
  const state = await readMobileLibrarySyncState();

  if (!state) {
    return 0;
  }

  // Collections still in the sync state count until the next sync moves them, and only where
  // the cookbook has none with that id (as moveStateCollections does).
  const known = new Set(collections.map((collection) => collection.id));
  const local = readLocalItems(records, [
    ...collections,
    ...Object.entries(state.collections ?? {})
      .filter(([id]) => !known.has(id))
      .map(([id, stored]) => fromLibraryCollection(id, stored.payload, stored.updatedAt))
  ]);
  let count = 0;

  for (const [key, item] of local) {
    const base = state.bases[key];

    if (
      !base?.fingerprint ||
      fingerprintKey(base.fingerprint) !== fingerprintKeyOf(item.kind, item.payload)
    ) {
      count += 1;
    }
  }

  for (const [key, base] of Object.entries(state.bases)) {
    if (base.fingerprint && !local.has(key)) {
      count += 1;
    }
  }

  return count;
};

/**
 * Replaces this device's cookbook (linked to another account) with `account`'s: every recipe but
 * the starters goes, with every collection, and the cookbook is linked to `account`, so its next
 * sync brings that account's cookbook in.
 */
export const replaceMobileLibrary = async (
  account: string,
  cookbook: MobileLibraryCookbook
): Promise<void> => {
  let removed: SavedRecipeRecord[] = [];

  cookbook.commitRecords((records) => {
    removed = records.filter(isSyncedRecord);
    return records.filter((record) => !isSyncedRecord(record));
  });
  cookbook.commitCollections(() => []);
  await cookbook.persist(removed);
  await writeState(newState(account));
};
