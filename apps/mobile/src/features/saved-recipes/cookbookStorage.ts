/**
 * Where the cookbook on this device is stored: one AsyncStorage value per recipe plus an index.
 *
 * Builds up to 2.0.x kept the whole cookbook in one value (`linkdish.savedRecipes`) and rewrote
 * all of it on every change. That got slower as cookbooks grew, and Android's SQLite-backed
 * AsyncStorage can't read a single value much over 2 MB back at all. Now:
 *
 * - each recipe is its own value under {@link COOKBOOK_RECIPE_STORAGE_KEY_PREFIX}, and a write
 *   only stores the recipes that changed;
 * - the index ({@link COOKBOOK_INDEX_STORAGE_KEY}) lists which recipes are in the cookbook, in
 *   order. Changed recipes and the index go in one `multiSet` (a single SQLite transaction on
 *   Android), so a crash leaves either the old cookbook or the new one; values of removed
 *   recipes are deleted after it, and any left behind are cleaned up on the next launch;
 * - the old value is moved over once, on the first launch of this build, and deleted only after
 *   the new copy is written. If that write fails, the cookbook keeps using the old value until a
 *   later launch moves it. One that can't be read is never deleted.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  createSavedRecipeId,
  normalizeSavedRecipeRecord,
  readSavedRecipeRecords,
  serializeSavedRecipeRecord,
  serializeSavedRecipeRecords,
  type SavedRecipeReadStatus,
  type SavedRecipeRecord
} from "./store";

/** The whole cookbook as one value, from builds up to 2.0.x. */
export const LEGACY_COOKBOOK_STORAGE_KEY = "linkdish.savedRecipes";
/** A copy of an old cookbook value that couldn't be understood, kept for recovery. */
export const LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY = "linkdish.savedRecipes.corrupt.v1";
export const COOKBOOK_INDEX_STORAGE_KEY = "linkdish.cookbook.v2.index";
export const COOKBOOK_RECIPE_STORAGE_KEY_PREFIX = "linkdish.cookbook.v2.recipe:";

export const cookbookRecipeStorageKey = (id: string): string =>
  `${COOKBOOK_RECIPE_STORAGE_KEY_PREFIX}${id}`;

const recipeIdOfStorageKey = (key: string): string =>
  key.slice(COOKBOOK_RECIPE_STORAGE_KEY_PREFIX.length);

/** What is stored under {@link COOKBOOK_INDEX_STORAGE_KEY}. */
export interface CookbookIndex {
  /** The cookbook's recipes, in order. */
  ids: string[];
  /**
   * Whether the old one-value cookbook is in this one (or there was none). False while that
   * value couldn't be read: a later launch that can read it adds the recipes it has.
   */
  legacyMigrated: boolean;
  version: 2;
}

export type CookbookKeyValueStorage = Pick<
  typeof AsyncStorage,
  "getAllKeys" | "getItem" | "multiGet" | "multiRemove" | "multiSet" | "setItem"
>;

export interface CookbookReadResult {
  /**
   * Some stored recipes couldn't be read (the old one-value cookbook, or a recipe's own value).
   * What was read is returned and the rest is left as stored. Cloud sync must stay off then: it
   * would take a recipe missing here for one deleted here.
   */
  incomplete?: boolean;
  /** The old one-value cookbook was moved into per-recipe storage by this read. */
  migrated?: boolean;
  records: SavedRecipeRecord[];
  /**
   * `corrupt`: there is a stored cookbook, but nothing in it could be understood, so callers
   * must not treat it as empty (see readSavedRecipeRecords).
   */
  status: SavedRecipeReadStatus;
}

export interface CookbookStorage {
  /** Reads the stored cookbook, moving an old one-value cookbook over first. Call once. */
  read: () => Promise<CookbookReadResult>;
  /**
   * Stores `records` as the whole cookbook, writing only what changed since the last read or
   * write. Calls must not overlap (the provider's debounced writer runs them one at a time).
   * Throws, without writing, when the stored cookbook couldn't be read: writing then could
   * drop recipes this device has but never loaded.
   */
  write: (records: readonly SavedRecipeRecord[]) => Promise<void>;
}

const parseCookbookIndex = (value: string | null): CookbookIndex | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<CookbookIndex> | null;

    if (
      parsed?.version !== 2 ||
      !Array.isArray(parsed.ids) ||
      !parsed.ids.every((id) => typeof id === "string")
    ) {
      return null;
    }

    return {
      ids: [...new Set(parsed.ids)],
      legacyMigrated: parsed.legacyMigrated === true,
      version: 2
    };
  } catch {
    return null;
  }
};

const parseStoredRecipe = (value: string | null): SavedRecipeRecord | null => {
  if (!value) {
    return null;
  }

  try {
    return normalizeSavedRecipeRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

/**
 * Gives every record after the first with the same id one of its own. Old one-value cookbooks
 * could hold two (ids fell back to the source URL), and per-recipe storage keeps one per id.
 */
const withUniqueIds = (records: SavedRecipeRecord[]): SavedRecipeRecord[] => {
  const seen = new Set<string>();

  return records.map((record) => {
    if (!seen.has(record.id)) {
      seen.add(record.id);
      return record;
    }

    let id = createSavedRecipeId(new Date(record.savedAt));

    while (seen.has(id)) {
      id = createSavedRecipeId(new Date(record.savedAt));
    }

    seen.add(id);
    return { ...record, id };
  });
};

const newestSavedFirst = (left: SavedRecipeRecord, right: SavedRecipeRecord): number =>
  right.savedAt.localeCompare(left.savedAt);

export interface CookbookStorageOptions {
  /**
   * Applied to the old one-value cookbook's recipes before they are moved over (and before the
   * old value is deleted): the provider writes inlined scan photos to files here, so the moved
   * copy points at them instead of losing them.
   */
  prepareLegacyRecords?: (records: SavedRecipeRecord[]) => SavedRecipeRecord[];
}

export const createCookbookStorage = (
  storage: CookbookKeyValueStorage = AsyncStorage,
  { prepareLegacyRecords = (records) => records }: CookbookStorageOptions = {}
): CookbookStorage => {
  /**
   * `legacy`: the old value couldn't be moved over this launch, so it is still written.
   * `unloaded`: nothing was read yet, or reading failed; nothing is written then.
   */
  let mode: "legacy" | "unloaded" | "v2" = "unloaded";
  /** The stored value of each recipe in the index, as last read or written. */
  const storedValues = new Map<string, string>();
  /** Ids in the index whose stored value couldn't be read: kept as they are, never deleted. */
  const unreadableIds = new Set<string>();
  let storedIndex: string | null = null;
  let legacyMigrated = false;
  /** The old value is in per-recipe storage (or backed up) but still stored. */
  let legacyNeedsRemoval = false;
  let lastLegacyWrite: string | null = null;
  /** Serialized records by identity: records are never changed in place. */
  const serialized = new WeakMap<SavedRecipeRecord, string>();

  const serialize = (record: SavedRecipeRecord): string => {
    let value = serialized.get(record);

    if (value === undefined) {
      value = serializeSavedRecipeRecord(record);
      serialized.set(record, value);
    }

    return value;
  };

  const indexValue = (ids: string[]): string =>
    JSON.stringify({ ids, legacyMigrated, version: 2 } satisfies CookbookIndex);

  const removeQuietly = async (keys: string[], what: string): Promise<boolean> => {
    if (keys.length === 0) {
      return true;
    }

    try {
      await storage.multiRemove(keys);
      return true;
    } catch (error) {
      console.warn(`Failed to remove ${what}.`, error);
      return false;
    }
  };

  /** The recipes stored under `ids`, in that order; ones that can't be read are kept aside. */
  const readRecipes = async (ids: readonly string[]): Promise<SavedRecipeRecord[]> => {
    if (ids.length === 0) {
      return [];
    }

    const keys = ids.map(cookbookRecipeStorageKey);
    /** Each recipe's stored value; `undefined` when storage couldn't read it. */
    let values: Array<string | null | undefined>;

    try {
      values = (await storage.multiGet(keys)).map(([, value]) => value);
    } catch (error) {
      // One value storage can't read (too large, or a damaged row) fails the whole batch: read
      // them one at a time, so only that one is left out.
      console.warn("Saved recipes could not be read together. Reading them one at a time.", error);
      values = await Promise.all(keys.map((key) => storage.getItem(key).catch(() => undefined)));
    }

    const records: SavedRecipeRecord[] = [];

    values.forEach((value, position) => {
      const id = ids[position]!;
      const record = value === undefined ? null : parseStoredRecipe(value);

      if (!record) {
        // Missing values are gone already; unreadable ones stay stored for recovery.
        if (value !== null) {
          console.warn("A saved recipe could not be read. Keeping the stored copy for recovery.");
          unreadableIds.add(id);
        }
        return;
      }

      // A recipe is always stored under its own id; read it as that.
      const stored = record.id === id ? record : { ...record, id };
      records.push(stored);
      storedValues.set(id, serialize(stored));
    });

    return records;
  };

  /** Copies an old value that can't be understood aside for recovery; true once it's copied. */
  const backUpUnreadableLegacy = async (value: string | null): Promise<boolean> => {
    try {
      if ((await storage.getItem(LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY)) !== value) {
        await storage.setItem(LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY, value ?? "");
      }
      return true;
    } catch (error) {
      console.warn("Failed to back up the unreadable saved recipes.", error);
      return false;
    }
  };

  /** Moves the old one-value cookbook into per-recipe storage. */
  const migrateLegacy = async (
    records: SavedRecipeRecord[],
    leftoverRecipeKeys: string[]
  ): Promise<boolean> => {
    const ids = records.map((record) => record.id);
    legacyMigrated = true;
    const index = indexValue(ids);

    try {
      await storage.multiSet([
        ...records.map(
          (record) => [cookbookRecipeStorageKey(record.id), serialize(record)] as const
        ),
        [COOKBOOK_INDEX_STORAGE_KEY, index]
      ]);
    } catch (error) {
      console.warn("Failed to move saved recipes to per-recipe storage.", error);
      legacyMigrated = false;
      return false;
    }

    storedIndex = index;
    records.forEach((record) => storedValues.set(record.id, serialize(record)));
    const kept = new Set(ids.map(cookbookRecipeStorageKey));
    await removeQuietly(
      leftoverRecipeKeys.filter((key) => !kept.has(key)),
      "leftover saved recipes"
    );
    legacyNeedsRemoval = !(await removeQuietly(
      [LEGACY_COOKBOOK_STORAGE_KEY],
      "the old saved recipes"
    ));
    return true;
  };

  const read = async (): Promise<CookbookReadResult> => {
    const keys = await storage.getAllKeys();
    const recipeKeys = keys.filter((key) => key.startsWith(COOKBOOK_RECIPE_STORAGE_KEY_PREFIX));
    const hasLegacy = keys.includes(LEGACY_COOKBOOK_STORAGE_KEY);
    const hasIndex = keys.includes(COOKBOOK_INDEX_STORAGE_KEY);
    const index = hasIndex
      ? parseCookbookIndex(await storage.getItem(COOKBOOK_INDEX_STORAGE_KEY))
      : null;

    if (!hasIndex && hasLegacy) {
      // The old value is read on its own: when it's too large to read, the rest still loads.
      let legacyValue: string | null;

      try {
        legacyValue = await storage.getItem(LEGACY_COOKBOOK_STORAGE_KEY);
      } catch (error) {
        console.warn("Saved recipes could not be read. Keeping the stored copy.", error);
        mode = "v2";
        return { incomplete: true, records: [], status: "corrupt" };
      }

      const legacy = readSavedRecipeRecords(legacyValue);

      if (legacy.status === "corrupt") {
        console.warn("Saved recipes could not be read. Keeping the stored copy for recovery.");
        // Backed up: the first cookbook written replaces it, as it always has.
        legacyNeedsRemoval = await backUpUnreadableLegacy(legacyValue);

        mode = "v2";
        return { records: [], status: "corrupt" };
      }

      const records = prepareLegacyRecords(withUniqueIds(legacy.records));

      if (!(await migrateLegacy(records, recipeKeys))) {
        mode = "legacy";
        lastLegacyWrite = legacyValue;
        return { records, status: legacy.status };
      }

      mode = "v2";
      return { migrated: true, records, status: legacy.status };
    }

    if (!hasIndex && recipeKeys.length === 0) {
      // Nothing stored yet.
      legacyMigrated = true;
      mode = "v2";
      return { records: [], status: "empty" };
    }

    let records: SavedRecipeRecord[];

    if (index) {
      records = await readRecipes(index.ids);
      legacyMigrated = index.legacyMigrated;
      // As it would be written, so an unchanged cookbook isn't rewritten.
      storedIndex = indexValue(index.ids);
      const listed = new Set(index.ids.map(cookbookRecipeStorageKey));
      // Values of recipes removed by a write that stopped before deleting them.
      await removeQuietly(
        recipeKeys.filter((key) => !listed.has(key)),
        "leftover saved recipes"
      );
    } else {
      // The index is missing or unreadable: every stored recipe is in, newest saved first, and
      // the next write stores a new index.
      console.warn("The saved recipes index could not be read. Rebuilding it.");
      const ids = recipeKeys.map(recipeIdOfStorageKey);
      records = (await readRecipes(ids)).sort(newestSavedFirst);
      legacyMigrated = false;
    }

    let incomplete = unreadableIds.size > 0;

    if (hasLegacy) {
      if (legacyMigrated) {
        // Moved over on an earlier launch, which then couldn't delete it.
        legacyNeedsRemoval = !(await removeQuietly(
          [LEGACY_COOKBOOK_STORAGE_KEY],
          "the old saved recipes"
        ));
      } else {
        try {
          const legacyValue = await storage.getItem(LEGACY_COOKBOOK_STORAGE_KEY);
          const legacy = readSavedRecipeRecords(legacyValue);

          if (legacy.status === "corrupt") {
            // Readable now but not understood: its recipes are missing here, so sync stays off
            // this launch (it would take them for deletions). Once it's backed up, the next write
            // deletes it, as a first launch does.
            console.warn(
              "The old saved recipes could not be understood. Keeping a copy for recovery."
            );
            incomplete = true;
            legacyNeedsRemoval = await backUpUnreadableLegacy(legacyValue);
          } else {
            // It couldn't be read when this cookbook was started: its recipes join it now, and
            // the next write stores them and deletes it.
            // One already here by id is kept as it is here. Ids are made unique before the
            // recipes are prepared, so two that shared one never write scans to the same files.
            const present = new Set(records.map((record) => record.id));
            const added = withUniqueIds([
              ...records,
              ...legacy.records.filter((record) => !present.has(record.id))
            ]).slice(records.length);
            records = [...records, ...prepareLegacyRecords(added)];
            legacyMigrated = true;
            legacyNeedsRemoval = true;
          }
        } catch (error) {
          console.warn("The old saved recipes still could not be read.", error);
          incomplete = true;
        }
      }
    }

    mode = "v2";
    return { ...(incomplete ? { incomplete } : {}), records, status: "ok" };
  };

  let reading: Promise<CookbookReadResult> | null = null;

  const writeLegacy = async (records: readonly SavedRecipeRecord[]): Promise<void> => {
    const value = serializeSavedRecipeRecords([...records]);

    if (value === lastLegacyWrite) {
      return;
    }

    await storage.setItem(LEGACY_COOKBOOK_STORAGE_KEY, value);
    lastLegacyWrite = value;
  };

  const write = async (records: readonly SavedRecipeRecord[]): Promise<void> => {
    await reading?.catch(() => undefined);

    if (mode === "unloaded") {
      throw new Error("The stored cookbook was not read, so it is not written over.");
    }

    if (mode === "legacy") {
      return writeLegacy(records);
    }

    const ids: string[] = [];
    const listed = new Set<string>();
    const changes: Array<readonly [string, string]> = [];

    for (const record of records) {
      if (listed.has(record.id)) {
        console.warn("Two saved recipes share an id. Storing the first.");
        continue;
      }

      listed.add(record.id);
      ids.push(record.id);
      const value = serialize(record);

      if (storedValues.get(record.id) !== value) {
        changes.push([cookbookRecipeStorageKey(record.id), value]);
      }
    }

    for (const id of unreadableIds) {
      if (!listed.has(id)) {
        listed.add(id);
        ids.push(id);
      }
    }

    const index = indexValue(ids);

    if (index !== storedIndex) {
      changes.push([COOKBOOK_INDEX_STORAGE_KEY, index]);
    }

    if (changes.length > 0) {
      await storage.multiSet(changes);
      storedIndex = index;

      for (const [key, value] of changes) {
        if (key !== COOKBOOK_INDEX_STORAGE_KEY) {
          storedValues.set(recipeIdOfStorageKey(key), value);
        }
      }

      for (const record of records) {
        // A stored record replaces an unreadable value under its id.
        unreadableIds.delete(record.id);
      }
    }

    // The index no longer lists these, so the cookbook is stored whether or not this works; a
    // later write (or launch) retries.
    const removedIds = [...storedValues.keys()].filter((id) => !listed.has(id));
    const removals = removedIds.map(cookbookRecipeStorageKey);

    if (legacyNeedsRemoval) {
      removals.push(LEGACY_COOKBOOK_STORAGE_KEY);
    }

    if (await removeQuietly(removals, "deleted saved recipes")) {
      removedIds.forEach((id) => storedValues.delete(id));
      legacyNeedsRemoval = false;
    }
  };

  return {
    read: () => {
      reading = read().catch((error: unknown) => {
        mode = "unloaded";
        throw error;
      });
      return reading;
    },
    write
  };
};
