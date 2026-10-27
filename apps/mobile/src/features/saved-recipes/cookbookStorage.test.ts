import { describe, expect, it, vi } from "vitest";

import {
  COOKBOOK_INDEX_STORAGE_KEY,
  LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY,
  LEGACY_COOKBOOK_STORAGE_KEY,
  cookbookRecipeStorageKey,
  createCookbookStorage,
  type CookbookKeyValueStorage
} from "./cookbookStorage";
import { createSavedRecipeRecord, type SavedRecipeRecord } from "./store";

import type { SuccessfulExtractionState } from "../recipe-results/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));

const buildRecord = (index: number): SavedRecipeRecord => {
  const state: SuccessfulExtractionState = {
    state: "success",
    fetchMode: "http",
    provenance: ["visible-text"],
    recipe: {
      title: `Soup ${index}`,
      sourceUrl: `https://example.com/soup-${index}`,
      sourceType: "article",
      ingredients: [{ text: "1 onion" }],
      steps: [{ index: 1, text: "Cook." }],
      servings: "4 servings",
      prepTimeMinutes: 10,
      cookTimeMinutes: 20,
      nutrition: null,
      confidence: {
        score: 0.9,
        summary: "Confident extraction.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "visible-text",
          ingredients: "visible-text",
          steps: "visible-text",
          servings: "visible-text",
          prepTimeMinutes: "visible-text",
          cookTimeMinutes: "visible-text",
          nutrition: null
        }
      }
    },
    strategy: "article-pattern",
    warnings: []
  };

  return {
    ...createSavedRecipeRecord(state, `2026-04-19T12:${String(index).padStart(2, "0")}:00.000Z`),
    id: `saved-${index}`
  };
};

/** AsyncStorage over a Map, as each launch of the app would see it. */
const createFakeStorage = (data = new Map<string, string>()) => {
  const storage = {
    getAllKeys: vi.fn(() => Promise.resolve([...data.keys()])),
    getItem: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    multiGet: vi.fn((keys: readonly string[]) =>
      Promise.resolve(keys.map((key) => [key, data.get(key) ?? null] as [string, string | null]))
    ),
    multiRemove: vi.fn((keys: readonly string[]) => {
      keys.forEach((key) => data.delete(key));
      return Promise.resolve();
    }),
    multiSet: vi.fn((pairs: ReadonlyArray<readonly [string, string]>) => {
      pairs.forEach(([key, value]) => data.set(key, value));
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    })
  };

  return { data, storage: storage as typeof storage & CookbookKeyValueStorage };
};

const indexOf = (data: Map<string, string>) =>
  JSON.parse(data.get(COOKBOOK_INDEX_STORAGE_KEY) ?? "null") as {
    ids: string[];
    legacyMigrated: boolean;
  } | null;

/** The next launch, over the same stored data. */
const relaunch = (data: Map<string, string>) => {
  const fake = createFakeStorage(data);
  return { ...fake, cookbook: createCookbookStorage(fake.storage) };
};

const ids = (records: readonly SavedRecipeRecord[]) => records.map((record) => record.id);

describe("cookbook storage", () => {
  it("stores each recipe on its own, plus an index in order", async () => {
    const { cookbook, data } = relaunch(new Map());
    const records = [buildRecord(2), buildRecord(1)];

    expect(await cookbook.read()).toEqual({ records: [], status: "empty" });
    await cookbook.write(records);

    expect(indexOf(data)).toEqual({
      ids: ["saved-2", "saved-1"],
      legacyMigrated: true,
      version: 2
    });
    expect(JSON.parse(data.get(cookbookRecipeStorageKey("saved-1"))!)).toMatchObject({
      id: "saved-1"
    });

    const next = relaunch(data);
    const read = await next.cookbook.read();
    expect(read.status).toBe("ok");
    expect(ids(read.records)).toEqual(["saved-2", "saved-1"]);
  });

  it("writes only the recipes that changed, and deletes removed ones after the index", async () => {
    const { cookbook, data, storage } = relaunch(new Map());
    const [first, second, third] = [buildRecord(1), buildRecord(2), buildRecord(3)];
    await cookbook.read();
    await cookbook.write([first, second, third]);
    storage.multiSet.mockClear();

    // Unchanged: nothing is written.
    await cookbook.write([first, second, third]);
    expect(storage.multiSet).not.toHaveBeenCalled();

    // One edit: that recipe alone.
    const edited = { ...second, favorite: true };
    await cookbook.write([first, edited, third]);
    expect(storage.multiSet).toHaveBeenCalledTimes(1);
    expect(storage.multiSet.mock.calls[0]![0].map(([key]) => key)).toEqual([
      cookbookRecipeStorageKey("saved-2")
    ]);

    // A removal: the index first, then the recipe's value.
    storage.multiSet.mockClear();
    await cookbook.write([first, edited]);
    expect(storage.multiSet.mock.calls[0]![0].map(([key]) => key)).toEqual([
      COOKBOOK_INDEX_STORAGE_KEY
    ]);
    expect(storage.multiRemove).toHaveBeenLastCalledWith([cookbookRecipeStorageKey("saved-3")]);
    expect(storage.multiSet.mock.invocationCallOrder[0]!).toBeLessThan(
      storage.multiRemove.mock.invocationCallOrder.at(-1)!
    );
    expect(data.has(cookbookRecipeStorageKey("saved-3"))).toBe(false);
  });

  it("doesn't rewrite a cookbook it just read", async () => {
    const { data } = relaunch(new Map());
    const first = relaunch(data);
    await first.cookbook.read();
    await first.cookbook.write([buildRecord(1), buildRecord(2)]);

    const next = relaunch(data);
    const { records } = await next.cookbook.read();
    await next.cookbook.write(records);

    expect(next.storage.multiSet).not.toHaveBeenCalled();
    expect(next.storage.multiRemove).not.toHaveBeenCalled();
  });

  it("fails a write it couldn't store, and stores it on the next one", async () => {
    const { cookbook, data, storage } = relaunch(new Map());
    await cookbook.read();
    storage.multiSet.mockRejectedValueOnce(new Error("database or disk is full"));

    await expect(cookbook.write([buildRecord(1)])).rejects.toThrow("disk is full");
    expect(data.size).toBe(0);

    await cookbook.write([buildRecord(1)]);
    expect(indexOf(data)?.ids).toEqual(["saved-1"]);
  });

  it("retries deleting a removed recipe's value when that fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { cookbook, data, storage } = relaunch(new Map());
    await cookbook.read();
    await cookbook.write([buildRecord(1), buildRecord(2)]);
    storage.multiRemove.mockRejectedValueOnce(new Error("busy"));

    // Stored all the same: the index no longer lists it.
    await cookbook.write([buildRecord(1)]);
    expect(indexOf(data)?.ids).toEqual(["saved-1"]);
    expect(data.has(cookbookRecipeStorageKey("saved-2"))).toBe(true);

    await cookbook.write([buildRecord(1)]);
    expect(data.has(cookbookRecipeStorageKey("saved-2"))).toBe(false);
  });

  it("cleans up values the index doesn't list when it loads", async () => {
    const { data } = relaunch(new Map());
    const first = relaunch(data);
    await first.cookbook.read();
    await first.cookbook.write([buildRecord(1)]);
    data.set(cookbookRecipeStorageKey("saved-9"), JSON.stringify(buildRecord(9)));

    const { records } = await relaunch(data).cookbook.read();

    expect(ids(records)).toEqual(["saved-1"]);
    expect(data.has(cookbookRecipeStorageKey("saved-9"))).toBe(false);
  });

  it("keeps a recipe value it can't read, without showing it, and reports the read incomplete", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { data } = relaunch(new Map());
    const first = relaunch(data);
    await first.cookbook.read();
    await first.cookbook.write([buildRecord(1), buildRecord(2)]);
    data.set(cookbookRecipeStorageKey("saved-2"), '{"recipe":');

    const next = relaunch(data);
    const { incomplete, records } = await next.cookbook.read();
    expect(ids(records)).toEqual(["saved-1"]);
    // Sync would take it for a deletion.
    expect(incomplete).toBe(true);

    await next.cookbook.write([...records, buildRecord(3)]);
    expect(data.get(cookbookRecipeStorageKey("saved-2"))).toBe('{"recipe":');
    expect(indexOf(data)?.ids).toEqual(["saved-1", "saved-3", "saved-2"]);
  });

  it("reads recipes one at a time when one of them can't be read with the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { data } = relaunch(new Map());
    const first = relaunch(data);
    await first.cookbook.read();
    await first.cookbook.write([buildRecord(1), buildRecord(2), buildRecord(3)]);

    const next = relaunch(data);
    next.storage.multiGet.mockRejectedValue(new Error("Row too big to fit into CursorWindow"));
    next.storage.getItem.mockImplementation((key: string) =>
      key === cookbookRecipeStorageKey("saved-2")
        ? Promise.reject(new Error("Row too big to fit into CursorWindow"))
        : Promise.resolve(data.get(key) ?? null)
    );
    const { incomplete, records } = await next.cookbook.read();

    expect(ids(records)).toEqual(["saved-1", "saved-3"]);
    expect(incomplete).toBe(true);

    // Saves still land, and the one it couldn't read stays stored and listed.
    await next.cookbook.write([...records, buildRecord(4)]);
    expect(data.has(cookbookRecipeStorageKey("saved-2"))).toBe(true);
    expect(indexOf(data)?.ids).toEqual(["saved-1", "saved-3", "saved-4", "saved-2"]);
  });

  it("rebuilds an unreadable index from the stored recipes, newest saved first", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { data } = relaunch(new Map());
    const first = relaunch(data);
    await first.cookbook.read();
    await first.cookbook.write([buildRecord(1), buildRecord(3), buildRecord(2)]);
    data.set(COOKBOOK_INDEX_STORAGE_KEY, "{broken");

    const next = relaunch(data);
    const { records, status } = await next.cookbook.read();
    expect(status).toBe("ok");
    expect(ids(records)).toEqual(["saved-3", "saved-2", "saved-1"]);

    await next.cookbook.write(records);
    expect(indexOf(data)?.ids).toEqual(["saved-3", "saved-2", "saved-1"]);
  });

  it("refuses to write when the stored cookbook couldn't be read", async () => {
    const { cookbook, data, storage } = relaunch(new Map());
    storage.getAllKeys.mockRejectedValueOnce(new Error("disk I/O error"));

    await expect(cookbook.read()).rejects.toThrow("disk I/O error");
    await expect(cookbook.write([buildRecord(1)])).rejects.toThrow("not read");
    expect(data.size).toBe(0);
  });

  describe("moving a cookbook stored as one value", () => {
    it("moves it over and deletes the old value", async () => {
      const stored = [buildRecord(2), buildRecord(1)];
      const { cookbook, data } = relaunch(
        new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify(stored)]])
      );

      const read = await cookbook.read();

      expect(read).toMatchObject({ migrated: true, status: "ok" });
      expect(ids(read.records)).toEqual(["saved-2", "saved-1"]);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
      expect(indexOf(data)).toMatchObject({ ids: ["saved-2", "saved-1"], legacyMigrated: true });
      expect(ids((await relaunch(data).cookbook.read()).records)).toEqual(["saved-2", "saved-1"]);
    });

    it("prepares its recipes before moving them, so the moved copy has what it needs", async () => {
      const stored = [buildRecord(1)];
      const data = new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify(stored)]]);
      const { storage } = createFakeStorage(data);
      const cookbook = createCookbookStorage(storage, {
        prepareLegacyRecords: (records) =>
          records.map((record) => ({
            ...record,
            sourceImages: [{ mimeType: "image/jpeg", uri: "file:///documents/recipe-scans/a.jpg" }]
          }))
      });

      const { records } = await cookbook.read();

      expect(records[0]!.sourceImages?.[0]?.uri).toBe("file:///documents/recipe-scans/a.jpg");
      expect(data.get(cookbookRecipeStorageKey("saved-1"))).toContain(
        "file:///documents/recipe-scans/a.jpg"
      );
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
    });

    it("keeps both of two recipes that shared an id", async () => {
      const original = buildRecord(1);
      const twin = { ...buildRecord(2), id: original.id };
      const { cookbook, data } = relaunch(
        new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify([original, twin])]])
      );

      const { records } = await cookbook.read();

      expect(records).toHaveLength(2);
      expect(records[0]!.id).toBe(original.id);
      expect(records[1]!.id).not.toBe(original.id);
      expect(records[1]!.recipe.title).toBe("Soup 2");
      expect(indexOf(data)?.ids).toEqual(ids(records));
    });

    it("keeps using the old value when the move can't be written, and moves it next launch", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stored = [buildRecord(1)];
      const { cookbook, data, storage } = relaunch(
        new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify(stored)]])
      );
      storage.multiSet.mockRejectedValueOnce(new Error("database or disk is full"));

      const read = await cookbook.read();
      expect(read.status).toBe("ok");
      expect(ids(read.records)).toEqual(["saved-1"]);
      expect(data.has(COOKBOOK_INDEX_STORAGE_KEY)).toBe(false);

      // This launch's changes still land, in the old value.
      await cookbook.write([...read.records, buildRecord(2)]);
      expect(
        ids(JSON.parse(data.get(LEGACY_COOKBOOK_STORAGE_KEY)!) as SavedRecipeRecord[])
      ).toEqual(["saved-1", "saved-2"]);
      expect(data.has(COOKBOOK_INDEX_STORAGE_KEY)).toBe(false);

      const next = await relaunch(data).cookbook.read();
      expect(next.migrated).toBe(true);
      expect(ids(next.records)).toEqual(["saved-1", "saved-2"]);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
    });

    it("backs up one it can't understand, and lets the first real cookbook replace it", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { cookbook, data } = relaunch(new Map([[LEGACY_COOKBOOK_STORAGE_KEY, "[{broken"]]));

      expect(await cookbook.read()).toEqual({ records: [], status: "corrupt" });
      expect(data.get(LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY)).toBe("[{broken");
      expect(data.get(LEGACY_COOKBOOK_STORAGE_KEY)).toBe("[{broken");

      await cookbook.write([buildRecord(1)]);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
      expect(data.get(LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY)).toBe("[{broken");
    });

    it("keeps sync off while a kept old value turns out not to be understood, then backs it up", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const data = new Map([[LEGACY_COOKBOOK_STORAGE_KEY, "[{broken"]]);
      const first = relaunch(data);
      first.storage.getItem.mockRejectedValueOnce(
        new Error("Row too big to fit into CursorWindow")
      );
      await first.cookbook.read();
      await first.cookbook.write([buildRecord(1)]);

      // Readable now, but not understood: its recipes are missing here, so the read is incomplete.
      const second = relaunch(data);
      const read = await second.cookbook.read();
      expect(read).toMatchObject({ incomplete: true, status: "ok" });
      expect(ids(read.records)).toEqual(["saved-1"]);
      expect(data.get(LEGACY_COOKBOOK_CORRUPT_BACKUP_STORAGE_KEY)).toBe("[{broken");

      // Backed up, so the next write lets it go, and later launches are complete.
      await second.cookbook.write(read.records);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
      expect((await relaunch(data).cookbook.read()).incomplete).toBeUndefined();
    });

    it("never deletes one it couldn't read, and adds its recipes once it can", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const stored = [buildRecord(1), buildRecord(2)];
      const { cookbook, data, storage } = relaunch(
        new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify(stored)]])
      );
      storage.getItem.mockRejectedValueOnce(new Error("Row too big to fit into CursorWindow"));

      expect(await cookbook.read()).toEqual({ incomplete: true, records: [], status: "corrupt" });

      // Saves meanwhile are stored apart from it.
      await cookbook.write([buildRecord(3)]);
      expect(indexOf(data)).toMatchObject({ ids: ["saved-3"], legacyMigrated: false });
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(true);

      // Still unreadable next launch: what is stored apart loads, and it stays.
      const stillLarge = relaunch(data);
      stillLarge.storage.getItem.mockImplementation((key: string) =>
        key === LEGACY_COOKBOOK_STORAGE_KEY
          ? Promise.reject(new Error("Row too big to fit into CursorWindow"))
          : Promise.resolve(data.get(key) ?? null)
      );
      const partial = await stillLarge.cookbook.read();
      expect(partial).toMatchObject({ incomplete: true, status: "ok" });
      expect(ids(partial.records)).toEqual(["saved-3"]);
      await stillLarge.cookbook.write(partial.records);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(true);

      // Readable at last: its recipes join (one already here by id stays as it is here), and it
      // goes once they're stored.
      data.set(
        LEGACY_COOKBOOK_STORAGE_KEY,
        JSON.stringify([...stored, { ...buildRecord(4), id: "saved-3" }])
      );
      const readable = relaunch(data);
      const merged = await readable.cookbook.read();
      expect(merged.incomplete).toBeUndefined();
      expect(ids(merged.records)).toEqual(["saved-3", "saved-1", "saved-2"]);
      expect(merged.records[0]!.recipe.title).toBe("Soup 3");
      await readable.cookbook.write(merged.records);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
      expect(indexOf(data)).toMatchObject({
        ids: ["saved-3", "saved-1", "saved-2"],
        legacyMigrated: true
      });
    });

    it("gives old recipes that shared an id their own ids before preparing them on a merge", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const original = buildRecord(1);
      const twin = { ...buildRecord(2), id: original.id };
      const data = new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify([original, twin])]]);
      const first = relaunch(data);
      first.storage.getItem.mockRejectedValueOnce(
        new Error("Row too big to fit into CursorWindow")
      );
      await first.cookbook.read();
      await first.cookbook.write([buildRecord(3)]);

      const prepared: string[][] = [];
      const cookbook = createCookbookStorage(createFakeStorage(data).storage, {
        prepareLegacyRecords: (records) => {
          prepared.push(ids(records));
          return records;
        }
      });
      const { records } = await cookbook.read();

      expect(records).toHaveLength(3);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toHaveLength(2);
      expect(new Set(prepared[0]).size).toBe(2);
      expect(prepared[0]![0]).toBe(original.id);
    });

    it("deletes an old value left behind by an earlier move", async () => {
      const stored = [buildRecord(1)];
      const { data } = relaunch(new Map([[LEGACY_COOKBOOK_STORAGE_KEY, JSON.stringify(stored)]]));
      const first = relaunch(data);
      first.storage.multiRemove.mockRejectedValue(new Error("busy"));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await first.cookbook.read();
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(true);

      // Deleted next launch, without reading it again or bringing back what it had.
      const next = relaunch(data);
      const { records } = await next.cookbook.read();
      expect(ids(records)).toEqual(["saved-1"]);
      expect(next.storage.getItem).not.toHaveBeenCalledWith(LEGACY_COOKBOOK_STORAGE_KEY);
      expect(data.has(LEGACY_COOKBOOK_STORAGE_KEY)).toBe(false);
    });
  });
});
