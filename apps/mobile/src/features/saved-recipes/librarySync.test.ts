import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  countMobileChangesNotSynced,
  LIBRARY_SYNC_STORAGE_KEY,
  readMobileLibrarySyncState,
  replaceMobileLibrary,
  syncMobileLibrary,
  unlinkMobileLibrary
} from "./librarySync";

import type { MobileLibraryCookbook } from "./librarySync";
import type { SavedRecipeRecord } from "./store";
import type { ExtractorApiClient } from "@linkdish/api-client";
import type { LibraryChange, LibraryRecipe } from "@linkdish/api-contracts";

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => Promise.resolve(storage.get(key) ?? null),
    removeItem: (key: string) => {
      storage.delete(key);
      return Promise.resolve();
    },
    setItem: (key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    }
  }
}));

const sample = SAMPLE_RECIPES[0];

const record = (id: string, overrides: Partial<SavedRecipeRecord> = {}): SavedRecipeRecord => ({
  fetchMode: "http",
  id,
  provenance: ["jsonld"],
  recipe: { ...sample.recipe, sourceUrl: `https://example.com/${id}`, title: id },
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "recipe-schema",
  timesCooked: 0,
  warnings: [],
  ...overrides
});

const libraryRecipe = (overrides: Partial<LibraryRecipe> = {}): LibraryRecipe => ({
  createdAt: "2026-10-02T12:00:00.000Z",
  fetchMode: "http",
  provenance: ["jsonld"],
  recipe: { ...sample.recipe, sourceUrl: "https://example.com/web-soup", title: "Web soup" },
  strategy: "recipe-schema",
  warnings: [],
  ...overrides
});

/** One account's cloud cookbook, as the API keeps it: the newest copy of an item wins. */
const createCloud = () => {
  const items = new Map<string, { change: LibraryChange; rev: number }>();
  let rev = 0;
  const store = (change: LibraryChange) => {
    rev += 1;
    items.set(`${change.kind}:${change.id}`, { change: structuredClone(change), rev });
  };
  const client = {
    pullLibraryChanges: vi.fn<ExtractorApiClient["pullLibraryChanges"]>((since) => {
      const page = [...items.values()]
        .filter((entry) => entry.rev > Number(since))
        .sort((left, right) => left.rev - right.rev);
      return Promise.resolve({
        changes: page.map((entry) => structuredClone(entry.change)),
        cursor: String(page.at(-1)?.rev ?? since),
        hasMore: false
      });
    }),
    pushLibraryChanges: vi.fn<ExtractorApiClient["pushLibraryChanges"]>((input) => {
      for (const change of input.changes) {
        store(change);
      }

      return Promise.resolve({
        accepted: input.changes.map((change) => ({ id: change.id, kind: change.kind })),
        newer: [],
        rejected: []
      });
    })
  };

  return {
    client,
    get: (key: string) => items.get(key)?.change,
    keys: () => [...items.keys()],
    store
  };
};

const createCookbook = (initial: SavedRecipeRecord[]) => {
  let records = initial;
  const persisted: SavedRecipeRecord[][] = [];
  const cookbook: MobileLibraryCookbook = {
    commitRecords: (update) => {
      records = update(records);
    },
    getRecords: () => records,
    persist: (removed) => {
      persisted.push([...removed]);
      return Promise.resolve();
    }
  };

  return {
    cookbook,
    get: (id: string) => records.find((entry) => entry.id === id),
    ids: () => records.map((entry) => entry.id),
    persisted,
    set: (next: SavedRecipeRecord[]) => {
      records = next;
    }
  };
};

beforeEach(() => {
  storage.clear();
});

describe("mobile cookbook sync", () => {
  it("links the cookbook to the first account and sends it, starters aside", async () => {
    const cloud = createCloud();
    const local = createCookbook([
      record("saved-1", { favorite: true, notes: " salty ", timesCooked: 2 }),
      record("starter-1", { isStarter: true })
    ]);

    await expect(
      syncMobileLibrary({
        account: "u1",
        client: cloud.client,
        cookbook: local.cookbook,
        isCurrent: () => true
      })
    ).resolves.toEqual({ held: 0, status: "synced" });

    expect(cloud.keys()).toEqual(["recipe:saved-1"]);
    expect(cloud.get("recipe:saved-1")?.recipe).toMatchObject({
      createdAt: "2026-10-01T12:00:00.000Z",
      favorite: true,
      notes: "salty",
      timesCooked: 2
    });
    expect(await readMobileLibrarySyncState()).toMatchObject({ account: "u1" });
  });

  it("keeps what this app doesn't show, so it syncs through untouched", async () => {
    const cloud = createCloud();
    cloud.store({
      collection: { createdAt: "2026-10-01T12:00:00.000Z", name: "Weeknights", sortOrder: 0 },
      id: "c1",
      kind: "collection",
      updatedAt: "2026-10-26T10:00:00.000Z"
    });
    cloud.store({
      id: "web-1",
      kind: "recipe",
      recipe: libraryRecipe({
        collectionIds: ["c1"],
        cookLog: [{ cookedAt: "2026-10-20T18:00:00.000Z" }],
        rating: 4,
        tags: ["Soup"],
        timesCooked: 1
      }),
      updatedAt: "2026-10-26T10:00:00.000Z"
    });
    const local = createCookbook([record("saved-1")]);
    const sync = () =>
      syncMobileLibrary({
        account: "u1",
        client: cloud.client,
        cookbook: local.cookbook,
        isCurrent: () => true
      });

    await sync();

    expect(local.ids()).toEqual(["web-1", "saved-1"]);
    expect(local.get("web-1")).toMatchObject({
      libraryExtras: { collectionIds: ["c1"], rating: 4, tags: ["Soup"] },
      recipe: { title: "Web soup" },
      savedAt: "2026-10-02T12:00:00.000Z",
      timesCooked: 1
    });
    expect(local.persisted).toEqual([[]]);

    // Favorited here: everything else it had goes back with it.
    local.set(
      local.cookbook
        .getRecords()
        .map((entry) => (entry.id === "web-1" ? { ...entry, favorite: true } : entry))
    );
    await sync();

    expect(cloud.get("recipe:web-1")?.recipe).toMatchObject({
      collectionIds: ["c1"],
      favorite: true,
      rating: 4,
      tags: ["Soup"]
    });
    expect(cloud.get("collection:c1")).not.toHaveProperty("deleted");
  });

  it("removes a recipe deleted elsewhere and lets go of its scans", async () => {
    const cloud = createCloud();
    const local = createCookbook([record("saved-1"), record("saved-2")]);
    const sync = () =>
      syncMobileLibrary({
        account: "u1",
        client: cloud.client,
        cookbook: local.cookbook,
        isCurrent: () => true
      });
    await sync();

    cloud.store({
      deleted: true,
      id: "saved-1",
      kind: "recipe",
      updatedAt: "2099-01-01T00:00:00.000Z"
    });
    await sync();

    expect(local.ids()).toEqual(["saved-2"]);
    expect(local.persisted.at(-1)?.map((entry) => entry.id)).toEqual(["saved-1"]);
  });

  it("never syncs another account's cookbook, and can replace it", async () => {
    const cloud = createCloud();
    const local = createCookbook([record("saved-1"), record("starter-1", { isStarter: true })]);
    await syncMobileLibrary({
      account: "u1",
      client: cloud.client,
      cookbook: local.cookbook,
      isCurrent: () => true
    });
    local.set([...local.cookbook.getRecords(), record("saved-2")]);
    cloud.client.pullLibraryChanges.mockClear();

    await expect(
      syncMobileLibrary({
        account: "u2",
        client: cloud.client,
        cookbook: local.cookbook,
        isCurrent: () => true
      })
    ).resolves.toEqual({ status: "other_account" });
    expect(cloud.client.pullLibraryChanges).not.toHaveBeenCalled();
    await expect(countMobileChangesNotSynced(local.cookbook.getRecords())).resolves.toBe(1);

    await replaceMobileLibrary("u2", local.cookbook);

    expect(local.ids()).toEqual(["starter-1"]);
    expect(await readMobileLibrarySyncState()).toMatchObject({ account: "u2", cursor: "0" });
  });

  it("unlinks the cookbook from a deleted account only", async () => {
    const cloud = createCloud();
    const local = createCookbook([record("saved-1")]);
    await syncMobileLibrary({
      account: "u1",
      client: cloud.client,
      cookbook: local.cookbook,
      isCurrent: () => true
    });

    await unlinkMobileLibrary("u2");
    expect(storage.has(LIBRARY_SYNC_STORAGE_KEY)).toBe(true);

    await unlinkMobileLibrary("u1");
    expect(storage.has(LIBRARY_SYNC_STORAGE_KEY)).toBe(false);
    expect(local.ids()).toEqual(["saved-1"]);
  });
});
