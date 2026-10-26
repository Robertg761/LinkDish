/**
 * Cloud sync of the signed-in account's cookbook on this device: the same engine as the web app
 * (`runLibrarySync` in @linkdish/recipe-domain) over the in-memory cookbook, with its bookkeeping
 * in AsyncStorage.
 *
 * - The cookbook on a device is linked to one account: the first to sign in on it (the two
 *   cookbooks are merged). Signing out keeps it; another account that signs in never syncs it,
 *   and can replace it with its own (see {@link replaceMobileLibrary}).
 * - Fields this app doesn't show yet (tags, collections, ratings, the cook log, preferred
 *   servings) are kept on the record as `libraryExtras`, and collections in the sync state, so
 *   they sync through untouched instead of being deleted.
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
  collections: Record<string, StoredCollection>;
}

const isState = (value: unknown): value is MobileLibrarySyncState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { account?: unknown }).account === "string" &&
  typeof (value as { cursor?: unknown }).cursor === "string" &&
  typeof (value as { bases?: unknown }).bases === "object" &&
  typeof (value as { collections?: unknown }).collections === "object";

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

const writeState = (state: MobileLibrarySyncState): Promise<void> =>
  AsyncStorage.setItem(LIBRARY_SYNC_STORAGE_KEY, JSON.stringify(state));

const newState = (account: string): MobileLibrarySyncState => ({
  account,
  bases: {},
  collections: {},
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
  collections: Record<string, StoredCollection>
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

  for (const [id, collection] of Object.entries(collections)) {
    items.set(librarySyncKey("collection", id), {
      id,
      kind: "collection",
      payload: collection.payload
    });
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
  /**
   * Stores the cookbook now (before the sync records that the cloud's copy is in it), and lets go
   * of scans only `removed` used.
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

const applyCollectionWrites = (
  state: MobileLibrarySyncState,
  writes: readonly LibraryLocalWrite[],
  written: Set<string>
) => {
  for (const write of writes) {
    const stored = state.collections[write.id];
    const storedKey = stored ? fingerprintKeyOf("collection", stored.payload) : null;

    if (storedKey !== write.expectedKey) {
      continue;
    }

    if (write.payload) {
      state.collections[write.id] = {
        payload: write.payload as unknown as LibraryCollection,
        updatedAt: write.updatedAt
      };
    } else {
      delete state.collections[write.id];
    }

    written.add(librarySyncKey("collection", write.id));
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
        linked,
        writes.filter((write) => write.kind === "collection"),
        written
      );

      if ([...written].some((key) => key.startsWith("recipe:"))) {
        await cookbook.persist(removed);
      }

      return written;
    },
    isCurrent,
    readLocal: () => Promise.resolve(readLocalItems(cookbook.getRecords(), linked.collections)),
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

      // Collections changed by applyLocal are stored with the bases that describe them.
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
  records: readonly SavedRecipeRecord[]
): Promise<number> => {
  const state = await readMobileLibrarySyncState();

  if (!state) {
    return 0;
  }

  const local = readLocalItems(records, state.collections);
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
 * the starters goes, and the cookbook is linked to `account`, so its next sync brings that
 * account's cookbook in.
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
  await cookbook.persist(removed);
  await writeState(newState(account));
};
