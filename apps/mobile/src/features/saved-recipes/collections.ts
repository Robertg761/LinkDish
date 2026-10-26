import {
  MAX_LIBRARY_COLLECTION_DESCRIPTION_LENGTH,
  MAX_LIBRARY_COLLECTION_EMOJI_LENGTH,
  MAX_LIBRARY_COLLECTION_NAME_LENGTH,
  MAX_LIBRARY_COLLECTIONS,
  MAX_LIBRARY_RECIPE_TAG_LENGTH,
  MAX_LIBRARY_RECIPE_TAGS
} from "@linkdish/api-contracts";

import type { SavedRecipeLibraryExtras, SavedRecipeRecord } from "./store";
import type { LibraryCollection } from "@linkdish/api-contracts";

/**
 * Collections ("Weeknights", "Holiday baking") and tags, as the web app has them. A collection
 * only stores its own details; membership lives on each recipe (`libraryExtras.collectionIds`),
 * as do its tags, so both sync with the recipe (see ./librarySync).
 */

export const COLLECTIONS_STORAGE_KEY = "linkdish.collections.v1";

export interface MobileCollection {
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

/** Quick picks for a collection's emoji (any emoji can still be typed). */
export const COLLECTION_EMOJI_CHOICES = [
  "🍝",
  "🥗",
  "🍲",
  "🌮",
  "🍜",
  "🥘",
  "🍰",
  "🍪",
  "🥞",
  "🍞",
  "🔥",
  "🌱",
  "🎄",
  "⭐"
] as const;

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

  if (cleaned.length > MAX_LIBRARY_COLLECTION_NAME_LENGTH) {
    throw new CollectionValidationError(
      `Collection names can be up to ${MAX_LIBRARY_COLLECTION_NAME_LENGTH} characters.`
    );
  }

  return cleaned;
};

const cleanOptional = (value: string | undefined, maxLength: number): string | undefined => {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
};

/** Sort order first, then name: the order collection lists are shown in. */
export const sortCollections = (collections: readonly MobileCollection[]): MobileCollection[] =>
  [...collections].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );

const createCollectionId = (date: Date): string =>
  `collection-${date.getTime()}-${Math.random().toString(36).slice(2, 10)}`;

/** A new collection at the end of the order. Throws CollectionValidationError on a bad name. */
export const createCollectionRecord = (
  existing: readonly MobileCollection[],
  input: CollectionInput,
  now = new Date()
): MobileCollection => {
  const name = cleanName(input.name);

  if (existing.length >= MAX_LIBRARY_COLLECTIONS) {
    throw new CollectionValidationError(
      `You can have up to ${MAX_LIBRARY_COLLECTIONS} collections.`
    );
  }

  const emoji = cleanOptional(input.emoji, MAX_LIBRARY_COLLECTION_EMOJI_LENGTH);
  const description = cleanOptional(input.description, MAX_LIBRARY_COLLECTION_DESCRIPTION_LENGTH);
  const stamp = now.toISOString();

  return {
    createdAt: stamp,
    id: createCollectionId(now),
    name,
    sortOrder: existing.reduce((max, collection) => Math.max(max, collection.sortOrder), -1) + 1,
    updatedAt: stamp,
    ...(emoji ? { emoji } : {}),
    ...(description ? { description } : {})
  };
};

/**
 * Changes only the fields in `patch` (an empty emoji or description removes it). Throws
 * CollectionValidationError on a bad name.
 */
export const updateCollectionRecord = (
  collection: MobileCollection,
  patch: CollectionPatch,
  now = new Date()
): MobileCollection => {
  const next: MobileCollection = {
    ...collection,
    ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
    ...(patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)
      ? { sortOrder: patch.sortOrder }
      : {}),
    updatedAt: now.toISOString()
  };

  if (patch.emoji !== undefined) {
    next.emoji = cleanOptional(patch.emoji, MAX_LIBRARY_COLLECTION_EMOJI_LENGTH);
  }

  if (patch.description !== undefined) {
    next.description = cleanOptional(patch.description, MAX_LIBRARY_COLLECTION_DESCRIPTION_LENGTH);
  }

  if (!next.emoji) {
    delete next.emoji;
  }

  if (!next.description) {
    delete next.description;
  }

  return next;
};

/** "🍝 Pasta night", or just the name when there is no emoji. */
export const formatCollectionLabel = (collection: Pick<MobileCollection, "emoji" | "name">) =>
  collection.emoji ? `${collection.emoji} ${collection.name}` : collection.name;

export const formatRecipeCount = (count: number): string =>
  count === 1 ? "1 recipe" : `${count} recipes`;

/** A collection as the cloud keeps it. */
export const toLibraryCollection = (collection: MobileCollection): LibraryCollection => ({
  createdAt: collection.createdAt,
  name: collection.name,
  sortOrder: collection.sortOrder,
  ...(collection.emoji ? { emoji: collection.emoji } : {}),
  ...(collection.description ? { description: collection.description } : {})
});

export const fromLibraryCollection = (
  id: string,
  payload: LibraryCollection,
  updatedAt: string
): MobileCollection => ({
  createdAt: payload.createdAt,
  id,
  name: payload.name,
  sortOrder: payload.sortOrder,
  updatedAt,
  ...(payload.emoji ? { emoji: payload.emoji } : {}),
  ...(payload.description ? { description: payload.description } : {})
});

const isString = (value: unknown): value is string => typeof value === "string";

/** Reads the stored collections; anything unreadable is left out. */
export const parseCollections = (serialized: string | null): MobileCollection[] => {
  if (!serialized) {
    return [];
  }

  try {
    const parsed = JSON.parse(serialized) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return sortCollections(
      parsed.flatMap((entry): MobileCollection[] => {
        const candidate = entry as Partial<Record<keyof MobileCollection, unknown>> | null;

        if (
          !candidate ||
          !isString(candidate.id) ||
          !isString(candidate.name) ||
          !candidate.name.trim() ||
          !isString(candidate.createdAt)
        ) {
          return [];
        }

        return [
          {
            createdAt: candidate.createdAt,
            id: candidate.id,
            name: candidate.name,
            sortOrder:
              typeof candidate.sortOrder === "number" && Number.isFinite(candidate.sortOrder)
                ? candidate.sortOrder
                : 0,
            updatedAt: isString(candidate.updatedAt) ? candidate.updatedAt : candidate.createdAt,
            ...(isString(candidate.emoji) && candidate.emoji ? { emoji: candidate.emoji } : {}),
            ...(isString(candidate.description) && candidate.description
              ? { description: candidate.description }
              : {})
          }
        ];
      })
    );
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------------------------------------
 * Tags and membership on recipes
 * ---------------------------------------------------------------------------------------------- */

/** Trimmed, single-spaced, deduplicated (ignoring case) and within the cloud's limits. */
export const normalizeRecipeTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const cleaned = tag.trim().replace(/\s+/gu, " ").slice(0, MAX_LIBRARY_RECIPE_TAG_LENGTH).trim();
    const key = cleaned.toLowerCase();

    if (!cleaned || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(cleaned);

    if (normalized.length >= MAX_LIBRARY_RECIPE_TAGS) {
      break;
    }
  }

  return normalized;
};

export const getRecipeTags = (record: Pick<SavedRecipeRecord, "libraryExtras">): string[] =>
  record.libraryExtras?.tags ?? [];

export const getRecipeCollectionIds = (
  record: Pick<SavedRecipeRecord, "libraryExtras">
): string[] => record.libraryExtras?.collectionIds ?? [];

const withExtra = <Key extends "collectionIds" | "tags">(
  record: SavedRecipeRecord,
  key: Key,
  value: string[]
): SavedRecipeRecord => {
  const extras: SavedRecipeLibraryExtras = { ...record.libraryExtras };

  if (value.length > 0) {
    extras[key] = value;
  } else {
    delete extras[key];
  }

  return {
    ...record,
    libraryExtras: Object.keys(extras).length > 0 ? extras : undefined
  };
};

export const setSavedRecipeTags = (
  records: SavedRecipeRecord[],
  id: string,
  tags: readonly string[]
): SavedRecipeRecord[] =>
  records.map((record) =>
    record.id === id ? withExtra(record, "tags", normalizeRecipeTags(tags)) : record
  );

export const setSavedRecipeCollectionIds = (
  records: SavedRecipeRecord[],
  id: string,
  collectionIds: readonly string[]
): SavedRecipeRecord[] =>
  records.map((record) =>
    record.id === id
      ? withExtra(record, "collectionIds", [
          ...new Set(collectionIds.map((entry) => entry.trim()).filter(Boolean))
        ])
      : record
  );

/** Every recipe without `collectionId` (the same array when none was in it). */
export const removeCollectionFromRecords = (
  records: SavedRecipeRecord[],
  collectionId: string
): SavedRecipeRecord[] => {
  let changed = false;
  const next = records.map((record) => {
    const ids = getRecipeCollectionIds(record);

    if (!ids.includes(collectionId)) {
      return record;
    }

    changed = true;
    return withExtra(
      record,
      "collectionIds",
      ids.filter((id) => id !== collectionId)
    );
  });

  return changed ? next : records;
};

/** How many recipes are in each collection. */
export const countRecipesByCollection = (
  records: readonly SavedRecipeRecord[]
): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const record of records) {
    for (const id of getRecipeCollectionIds(record)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return counts;
};

/** Every tag used across the cookbook with how often, most used first (first spelling wins). */
export const collectCookbookTags = (
  records: readonly Pick<SavedRecipeRecord, "libraryExtras">[]
): Array<{ count: number; label: string }> => {
  const counts = new Map<string, { label: string; count: number }>();

  for (const record of records) {
    for (const tag of getRecipeTags(record)) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);

      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { count: 1, label: tag });
      }
    }
  }

  return [...counts.values()].sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label)
  );
};

export const recipeHasTag = (
  record: Pick<SavedRecipeRecord, "libraryExtras">,
  tag: string
): boolean => {
  const key = tag.toLowerCase();
  return getRecipeTags(record).some((entry) => entry.toLowerCase() === key);
};
