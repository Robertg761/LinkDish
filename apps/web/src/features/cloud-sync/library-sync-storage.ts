/**
 * This browser's side of cloud sync storage: which account the cookbook is linked to, what the
 * cloud last had of each item (see `LibrarySyncBase` in @linkdish/recipe-domain), and the reads
 * and guarded writes a sync run makes to the cookbook. Everything is in the `linkdish-web`
 * database, so a link and its bookkeeping change together with the recipes they describe.
 */
import {
  fingerprintKey,
  fingerprintPayload,
  librarySyncGroupsFor,
  librarySyncKey,
  LibrarySyncCancelledError
} from "@linkdish/recipe-domain/src/library-sync";

import { emitDataChange } from "../../data/change-feed";
import { runLinkDishTransaction } from "../../storage/idb-transaction";
import {
  COLLECTIONS_STORE_NAME,
  COOK_SESSIONS_STORE_NAME,
  LIBRARY_SYNC_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import {
  removeCollectionFromRecipes,
  toSavedRecipeListRecord
} from "../library/saved-recipe-store";

import {
  fromLibraryCollection,
  fromLibraryRecipe,
  isSyncedCollection,
  isSyncedRecipe,
  toLibraryCollection,
  toLibraryRecipe
} from "./library-sync-records";

import type { WebCollection } from "../../data/collections-store";
import type { LinkDishTransaction } from "../../storage/idb-transaction";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { LibraryCollection, LibraryRecipe } from "@linkdish/api-contracts";
import type {
  LibraryItemKind,
  LibraryLocalWrite,
  LibrarySyncBase,
  LibrarySyncPayload,
  LibrarySyncState
} from "@linkdish/recipe-domain/src/library-sync";

const META_KEY = "meta";

/** The link: the account this browser's cookbook syncs with, and how far it has read its feed. */
export interface LibrarySyncLink {
  account: string;
  cursor: string;
  linkedAt: string;
}

interface StoredLink extends LibrarySyncLink {
  key: typeof META_KEY;
}

interface StoredBase extends LibrarySyncBase {
  key: string;
}

export interface LocalLibraryItem {
  kind: LibraryItemKind;
  id: string;
  payload: LibrarySyncPayload;
}

const isStoredLink = (value: unknown): value is StoredLink =>
  typeof value === "object" &&
  value !== null &&
  (value as { key?: unknown }).key === META_KEY &&
  typeof (value as { account?: unknown }).account === "string" &&
  typeof (value as { cursor?: unknown }).cursor === "string";

const toLink = ({ account, cursor, linkedAt }: StoredLink): LibrarySyncLink => ({
  account,
  cursor,
  linkedAt
});

const newLink = (account: string): StoredLink => ({
  account,
  cursor: "0",
  key: META_KEY,
  linkedAt: new Date().toISOString()
});

/** The account this browser's cookbook is linked to, if any. */
export async function readLibraryLink(): Promise<LibrarySyncLink | null> {
  const stored: unknown = await runLinkDishTransaction(
    [LIBRARY_SYNC_STORE_NAME],
    "readonly",
    (tx) => tx.objectStore(LIBRARY_SYNC_STORE_NAME).get(META_KEY)
  );

  return isStoredLink(stored) ? toLink(stored) : null;
}

/**
 * Links an unlinked cookbook to `account` (its first sync then merges the two). Resolves with the
 * link as stored: another account's, when another tab linked it first.
 */
export async function linkLibrary(account: string): Promise<LibrarySyncLink> {
  return runLinkDishTransaction([LIBRARY_SYNC_STORE_NAME], "readwrite", async (tx) => {
    const store = tx.objectStore(LIBRARY_SYNC_STORE_NAME);
    const stored: unknown = await store.get(META_KEY);

    if (isStoredLink(stored)) {
      return toLink(stored);
    }

    // Nothing is remembered of another account's cloud: start clean.
    await store.clear();
    const link = newLink(account);
    await store.put(link);
    return toLink(link);
  });
}

/**
 * Forgets the link (when `account` is the one linked, or always when it is left out). The recipes
 * stay; the next account to sign in links them to its own cookbook.
 */
export async function unlinkLibrary(account?: string): Promise<void> {
  await runLinkDishTransaction([LIBRARY_SYNC_STORE_NAME], "readwrite", async (tx) => {
    const store = tx.objectStore(LIBRARY_SYNC_STORE_NAME);
    const stored: unknown = await store.get(META_KEY);

    if (account === undefined || (isStoredLink(stored) && stored.account === account)) {
      await store.clear();
    }
  });
}

/* ------------------------------------------------------------------------------------------------
 * The cookbook as library items
 * ---------------------------------------------------------------------------------------------- */

const recipeItem = (record: WebSavedRecipe): LocalLibraryItem => ({
  id: record.id,
  kind: "recipe",
  payload: toLibraryRecipe(toSavedRecipeListRecord(record))
});

const collectionItem = (collection: WebCollection): LocalLibraryItem => ({
  id: collection.id,
  kind: "collection",
  payload: toLibraryCollection(collection)
});

const keyOf = (item: Pick<LocalLibraryItem, "id" | "kind">): string =>
  librarySyncKey(item.kind, item.id);

const fingerprintKeyOf = (item: LocalLibraryItem): string =>
  fingerprintKey(fingerprintPayload(item.payload, librarySyncGroupsFor(item.kind)));

/** Every recipe (but the starters) and collection in the cookbook, keyed by library key. */
export async function readLocalLibrary(): Promise<Map<string, LocalLibraryItem>> {
  const [recipes, collections] = await runLinkDishTransaction(
    [SAVED_RECIPES_STORE_NAME, COLLECTIONS_STORE_NAME],
    "readonly",
    (tx) =>
      Promise.all([
        tx.objectStore(SAVED_RECIPES_STORE_NAME).getAll() as Promise<WebSavedRecipe[]>,
        tx.objectStore(COLLECTIONS_STORE_NAME).getAll() as Promise<WebCollection[]>
      ])
  );
  const items = [
    ...recipes.filter(isSyncedRecipe).map(recipeItem),
    ...collections.filter(isSyncedCollection).map(collectionItem)
  ];

  return new Map(items.map((item) => [keyOf(item), item]));
}

const assertLinkedTo = async (
  tx: LinkDishTransaction<"readonly" | "readwrite">,
  account: string
): Promise<StoredLink> => {
  const stored: unknown = await tx.objectStore(LIBRARY_SYNC_STORE_NAME).get(META_KEY);

  if (!isStoredLink(stored) || stored.account !== account) {
    throw new LibrarySyncCancelledError();
  }

  return stored;
};

/** The cursor and bases of `account`'s link (rejects when the cookbook is no longer linked to it). */
export async function readLibrarySyncState(account: string): Promise<LibrarySyncState> {
  return runLinkDishTransaction([LIBRARY_SYNC_STORE_NAME], "readonly", async (tx) => {
    const link = await assertLinkedTo(tx, account);
    const records = (await tx.objectStore(LIBRARY_SYNC_STORE_NAME).getAll()) as unknown[];
    const bases = new Map<string, LibrarySyncBase>();

    for (const record of records) {
      if (record && typeof record === "object" && !isStoredLink(record)) {
        const { key, ...base } = record as StoredBase;
        bases.set(key, base);
      }
    }

    return { bases, cursor: link.cursor };
  });
}

/** Saves a run's progress for `account`'s link (`null` removes a base; a `null` cursor keeps it). */
export async function saveLibrarySyncState(
  account: string,
  cursor: string | null,
  bases: ReadonlyMap<string, LibrarySyncBase | null>
): Promise<void> {
  await runLinkDishTransaction([LIBRARY_SYNC_STORE_NAME], "readwrite", async (tx) => {
    const link = await assertLinkedTo(tx, account);
    const store = tx.objectStore(LIBRARY_SYNC_STORE_NAME);
    const writes: Array<Promise<unknown>> = [];

    if (cursor !== null && cursor !== link.cursor) {
      writes.push(store.put({ ...link, cursor }));
    }

    for (const [key, base] of bases) {
      writes.push(base ? store.put({ ...base, key } satisfies StoredBase) : store.delete(key));
    }

    await Promise.all(writes);
  });
}

/**
 * How many items differ from what the cloud last had (changes made here not synced yet), for the
 * warning before this browser's cookbook is replaced.
 */
export async function countUnsyncedLibraryChanges(account: string): Promise<number> {
  const [local, state] = await Promise.all([
    readLocalLibrary(),
    readLibrarySyncState(account).catch(() => null)
  ]);

  if (!state) {
    return local.size;
  }

  let count = 0;

  for (const [key, item] of local) {
    const base = state.bases.get(key);

    if (!base?.fingerprint || fingerprintKey(base.fingerprint) !== fingerprintKeyOf(item)) {
      count += 1;
    }
  }

  for (const [key, base] of state.bases) {
    if (base.fingerprint && !local.has(key)) {
      count += 1;
    }
  }

  return count;
}

/* ------------------------------------------------------------------------------------------------
 * Writes from the cloud
 * ---------------------------------------------------------------------------------------------- */

const APPLY_STORES = [
  SAVED_RECIPES_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  COOK_SESSIONS_STORE_NAME,
  COLLECTIONS_STORE_NAME,
  LIBRARY_SYNC_STORE_NAME
] as const;

interface AppliedChanges {
  written: Set<string>;
  recipes: WebSavedRecipe[];
  deletedRecipes: string[];
  collections: WebCollection[];
  deletedCollections: string[];
}

/**
 * Stores changes from the cloud for `account`'s link, in one transaction. A change is written only
 * while the item still is what it was merged with (`expectedKey`); the others are left for the
 * sync to merge again. Starters are never touched. A deleted recipe takes its scans and cook
 * session with it; a deleted collection is taken off the recipes filed in it.
 */
export async function applyLibraryWrites(
  account: string,
  writes: readonly LibraryLocalWrite[]
): Promise<Set<string>> {
  // Collections go last: taking a deleted one off its recipes changes them.
  const ordered = [...writes].sort(
    (left, right) =>
      Number(left.kind === "collection" && !left.payload) -
      Number(right.kind === "collection" && !right.payload)
  );

  const applied = await runLinkDishTransaction(APPLY_STORES, "readwrite", async (tx) => {
    await assertLinkedTo(tx, account);
    const recipes = tx.objectStore(SAVED_RECIPES_STORE_NAME);
    const collections = tx.objectStore(COLLECTIONS_STORE_NAME);
    const result: AppliedChanges = {
      collections: [],
      deletedCollections: [],
      deletedRecipes: [],
      recipes: [],
      written: new Set()
    };

    for (const write of ordered) {
      const key = librarySyncKey(write.kind, write.id);

      if (write.kind === "recipe") {
        const stored = (await recipes.get(write.id)) as WebSavedRecipe | undefined;

        if (
          (stored && !isSyncedRecipe(stored)) ||
          (stored ? fingerprintKeyOf(recipeItem(stored)) : null) !== write.expectedKey
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
          await recipes.put(next);
          result.recipes.push(toSavedRecipeListRecord(next));
        } else {
          await Promise.all([
            recipes.delete(write.id),
            tx.objectStore(RECIPE_SOURCE_IMAGES_STORE_NAME).delete(write.id),
            tx.objectStore(COOK_SESSIONS_STORE_NAME).delete(write.id)
          ]);
          result.deletedRecipes.push(write.id);
        }
      } else {
        const stored = (await collections.get(write.id)) as WebCollection | undefined;

        if ((stored ? fingerprintKeyOf(collectionItem(stored)) : null) !== write.expectedKey) {
          continue;
        }

        if (write.payload) {
          const next = fromLibraryCollection(
            stored,
            write.id,
            write.payload as unknown as LibraryCollection,
            write.updatedAt
          );
          await collections.put(next);
          result.collections.push(next);
        } else {
          const [unfiled] = await Promise.all([
            removeCollectionFromRecipes(recipes, write.id),
            collections.delete(write.id)
          ]);
          result.recipes.push(...unfiled);
          result.deletedCollections.push(write.id);
        }
      }

      result.written.add(key);
    }

    return result;
  });

  if (applied.recipes.length || applied.deletedRecipes.length) {
    emitDataChange({
      deletedIds: applied.deletedRecipes,
      topic: "savedRecipes",
      upserted: applied.recipes
    });
  }

  if (applied.deletedRecipes.length) {
    emitDataChange({ deletedIds: applied.deletedRecipes, topic: "cookSessions" });
  }

  if (applied.collections.length || applied.deletedCollections.length) {
    emitDataChange({
      deletedIds: applied.deletedCollections,
      topic: "collections",
      upserted: applied.collections
    });
  }

  return applied.written;
}

/**
 * Replaces this browser's cookbook with `account`'s: every recipe but the starters (with its scans
 * and cook session) and every collection is removed, and the cookbook is linked to `account`, so
 * its next sync brings that account's cookbook in. For a cookbook linked to another account.
 */
export async function replaceLocalLibrary(account: string): Promise<void> {
  await runLinkDishTransaction(APPLY_STORES, "readwrite", async (tx) => {
    const recipes = tx.objectStore(SAVED_RECIPES_STORE_NAME);
    const ids = ((await recipes.getAllKeys()) as string[]).filter((id) => isSyncedRecipe({ id }));

    await Promise.all([
      ...ids.flatMap((id) => [
        recipes.delete(id),
        tx.objectStore(RECIPE_SOURCE_IMAGES_STORE_NAME).delete(id),
        tx.objectStore(COOK_SESSIONS_STORE_NAME).delete(id)
      ]),
      tx.objectStore(COLLECTIONS_STORE_NAME).clear(),
      tx.objectStore(LIBRARY_SYNC_STORE_NAME).clear()
    ]);
    await tx.objectStore(LIBRARY_SYNC_STORE_NAME).put(newLink(account));
  });

  emitDataChange({ reload: true, topic: "savedRecipes" });
  emitDataChange({ reload: true, topic: "collections" });
  emitDataChange({ reload: true, topic: "cookSessions" });
}
