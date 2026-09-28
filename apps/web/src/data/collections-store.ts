import { useCallback, useMemo } from "react";

import { trackWebEvent } from "../analytics/client";
import { removeCollectionFromAllRecipes } from "../features/library/saved-recipe-store";
import { updateStoredRecord } from "../storage/idb-update";
import { COLLECTIONS_STORE_NAME, getLinkDishWebDb } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

import type { WebSavedRecipe } from "../features/library/saved-recipe-types";

/**
 * Recipe collections ("Weeknights", "Holiday baking", …). A collection only stores its own
 * details; membership lives on each recipe as `collectionIds` (see `setCollections` in
 * library-store), so deleting a recipe never leaves dangling references.
 */

export interface WebCollection {
  id: string;
  name: string;
  emoji?: string | undefined;
  description?: string | undefined;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionInput {
  name: string;
  emoji?: string | undefined;
  description?: string | undefined;
}

export type CollectionPatch = Partial<CollectionInput & { sortOrder: number }>;

export const MAX_COLLECTION_NAME_LENGTH = 60;
const MAX_COLLECTION_DESCRIPTION_LENGTH = 280;
const MAX_COLLECTION_EMOJI_LENGTH = 16;

export class CollectionValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CollectionValidationError";
  }
}

const cleanName = (name: string): string => {
  const cleaned = name.trim().replace(/\s+/gu, " ");

  if (!cleaned) {
    throw new CollectionValidationError("Give the collection a name.");
  }

  if (cleaned.length > MAX_COLLECTION_NAME_LENGTH) {
    throw new CollectionValidationError(
      `Collection names can be up to ${MAX_COLLECTION_NAME_LENGTH} characters.`
    );
  }

  return cleaned;
};

const cleanOptional = (value: string | undefined, maxLength: number): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
};

/** Sort order first, then name — the order collection lists are shown in. */
export const sortCollections = (collections: readonly WebCollection[]): WebCollection[] =>
  [...collections].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

export async function getCollections(): Promise<WebCollection[]> {
  const db = await getLinkDishWebDb();
  return sortCollections((await db.getAll(COLLECTIONS_STORE_NAME)) as WebCollection[]);
}

const collectionsResource = createResourceStore<WebCollection[]>({
  applyLocalChange: (current, change) => {
    const next = upsertById(
      current,
      change.upserted as WebCollection[] | undefined,
      change.deletedIds,
      (collection) => collection.id
    );
    return next === current ? current : sortCollections(next);
  },
  initial: [],
  load: getCollections,
  topic: "collections"
});

/** Sets an optional text field, or removes it when `value` is empty. */
const setOrDelete = (
  collection: WebCollection,
  key: "description" | "emoji",
  value: string
): void => {
  if (value) {
    collection[key] = value;
  } else {
    delete collection[key];
  }
};

/**
 * Adds a collection at the end of the order. Reading the order and writing the new collection
 * share one readwrite transaction, so collections created in two tabs at once each get a place.
 */
export async function createCollection(input: CollectionInput): Promise<WebCollection> {
  const name = cleanName(input.name);
  const now = new Date().toISOString();
  const emoji = cleanOptional(input.emoji, MAX_COLLECTION_EMOJI_LENGTH);
  const description = cleanOptional(input.description, MAX_COLLECTION_DESCRIPTION_LENGTH);
  const id = crypto.randomUUID();
  const db = await getLinkDishWebDb();
  const tx = db.transaction(COLLECTIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COLLECTIONS_STORE_NAME);
  const existing = (await store.getAll()) as WebCollection[];
  const created: WebCollection = {
    createdAt: now,
    id,
    name,
    sortOrder: existing.reduce((max, collection) => Math.max(max, collection.sortOrder), -1) + 1,
    updatedAt: now,
    ...(emoji ? { emoji } : {}),
    ...(description ? { description } : {})
  };

  await Promise.all([store.put(created), tx.done]);
  emitDataChange({ topic: "collections", upserted: [created] });

  trackWebEvent({
    eventName: "collection_created",
    properties: { collection_count: existing.length + 1, has_emoji: Boolean(emoji) },
    routeOrScreen: window.location.pathname
  });
  return created;
}

/**
 * Changes only the fields in `patch` (an empty emoji or description removes it). The collection is
 * read and written back in one readwrite transaction, so a change another tab makes to it
 * meanwhile (a rename there, a new emoji here) is kept, and a deleted collection stays deleted.
 */
export async function updateCollection(
  id: string,
  patch: CollectionPatch
): Promise<WebCollection | undefined> {
  // Validate first: the merge inside the transaction must not throw or wait.
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  const sortOrder =
    patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder) ? patch.sortOrder : undefined;
  const emoji =
    patch.emoji !== undefined
      ? (cleanOptional(patch.emoji, MAX_COLLECTION_EMOJI_LENGTH) ?? "")
      : undefined;
  const description =
    patch.description !== undefined
      ? (cleanOptional(patch.description, MAX_COLLECTION_DESCRIPTION_LENGTH) ?? "")
      : undefined;
  const updatedAt = new Date().toISOString();

  const written = await updateStoredRecord<WebCollection>(
    COLLECTIONS_STORE_NAME,
    id,
    (existing) => {
      if (!existing) {
        return undefined;
      }

      const next: WebCollection = {
        ...existing,
        ...(name !== undefined ? { name } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        updatedAt
      };

      if (emoji !== undefined) {
        setOrDelete(next, "emoji", emoji);
      }

      if (description !== undefined) {
        setOrDelete(next, "description", description);
      }

      return next;
    }
  );

  if (written) {
    emitDataChange({ topic: "collections", upserted: [written] });
  }

  return written;
}

/**
 * Moves collections into the given order (ids not listed keep their relative order after). The
 * collections are read and rewritten in one readwrite transaction, so a rename or new emoji
 * another tab saves meanwhile is kept.
 */
export async function reorderCollections(orderedIds: readonly string[]): Promise<void> {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  const now = new Date().toISOString();
  const db = await getLinkDishWebDb();
  const tx = db.transaction(COLLECTIONS_STORE_NAME, "readwrite");
  const store = tx.objectStore(COLLECTIONS_STORE_NAME);
  const collections = sortCollections((await store.getAll()) as WebCollection[]);
  const reordered = [...collections].sort(
    (a, b) =>
      (position.get(a.id) ?? orderedIds.length + a.sortOrder) -
      (position.get(b.id) ?? orderedIds.length + b.sortOrder)
  );
  const changed = reordered
    .map((collection, index) => ({ collection, index }))
    .filter(({ collection, index }) => collection.sortOrder !== index)
    .map(({ collection, index }) => ({ ...collection, sortOrder: index, updatedAt: now }));

  await Promise.all([...changed.map((collection) => store.put(collection)), tx.done]);

  if (changed.length) {
    emitDataChange({ topic: "collections", upserted: changed });
  }
}

/** Deletes a collection and removes it from every recipe (the recipes themselves stay). */
export async function deleteCollection(id: string): Promise<void> {
  const db = await getLinkDishWebDb();
  await db.delete(COLLECTIONS_STORE_NAME, id);
  emitDataChange({ deletedIds: [id], topic: "collections" });
  await removeCollectionFromAllRecipes(id);
}

/** Recipes that belong to a collection, in the order given. */
export const selectRecipesInCollection = (
  recipes: readonly WebSavedRecipe[],
  collectionId: string
): WebSavedRecipe[] => recipes.filter((recipe) => recipe.collectionIds?.includes(collectionId));

export interface CollectionsView {
  collections: WebCollection[];
  error: unknown;
  retry: () => void;
  status: "loading" | "ready" | "error";
}

export function useCollections(): CollectionsView {
  const snapshot = useResource(collectionsResource);
  const retry = useCallback(() => {
    void collectionsResource.load({ force: true });
  }, []);

  return useMemo(
    () => ({
      collections: snapshot.data,
      error: snapshot.error,
      retry,
      status: toViewStatus(snapshot.status)
    }),
    [retry, snapshot]
  );
}

export const loadCollections = (options?: { force?: boolean }): Promise<void> =>
  collectionsResource.load(options);

export const getCollectionsSnapshot = () => collectionsResource.getSnapshot();

export function resetCollectionsStoreForTests(): void {
  collectionsResource.reset();
}
