import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLLECTIONS_STORE_NAME,
  COOK_SESSIONS_STORE_NAME,
  ensureObjectStore,
  getLinkDishDbStatus,
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME,
  LINKDISH_WEB_DB_STORE_NAMES,
  LINKDISH_WEB_DB_VERSION,
  MEAL_PLAN_STORE_NAME,
  migrateSourceImagesToImageStore,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  retryLinkDishWebDb,
  SAVED_RECIPES_STORE_NAME,
  SHOPPING_ITEMS_STORE_NAME,
  subscribeLinkDishDbStatus,
  type MigrationRecordStore
} from "./linkdish-db";
import { fakeIdb } from "./testing/fake-idb";

vi.mock("idb", async () => (await import("./testing/fake-idb")).fakeIdbModule);

const SAVED_RECIPE_V1_INDEXES = {
  createdAt: "createdAt",
  sourceHost: "sourceHost",
  title: "recipe.title",
  updatedAt: "updatedAt"
};

const SHOPPING_V3_INDEXES = {
  checked: "checked",
  recipeTitle: "recipeTitle",
  syncStatus: "sync.status",
  updatedAt: "updatedAt"
};

const scan = (index: number) => ({
  dataUrl: `data:image/jpeg;base64,${"A".repeat(64)}${index}`,
  mimeType: "image/jpeg"
});

const legacyRecipe = (id: string, extra: Record<string, unknown> = {}) => ({
  createdAt: "2026-07-01T00:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id,
  recipe: {
    ingredients: [{ text: "1 cup rice" }],
    sourceType: "recipe-webpage",
    sourceUrl: `https://example.com/${id}`,
    steps: [{ index: 1, text: "Cook" }],
    title: `Recipe ${id}`
  },
  sourceHost: "example.com",
  sourceUrl: `https://example.com/${id}`,
  updatedAt: "2026-07-02T00:00:00.000Z",
  ...extra
});

const seedExistingSchema = (version: number) => {
  fakeIdb.reset(version);
  fakeIdb.defineStore(SAVED_RECIPES_STORE_NAME, "id", SAVED_RECIPE_V1_INDEXES);

  if (version >= 3) {
    fakeIdb.defineStore(SHOPPING_ITEMS_STORE_NAME, "id", SHOPPING_V3_INDEXES);
  }
};

const expectV4Stores = () => {
  for (const name of LINKDISH_WEB_DB_STORE_NAMES) {
    expect(fakeIdb.hasStore(name)).toBe(true);
  }

  expect(fakeIdb.indexKeyPaths(COLLECTIONS_STORE_NAME)).toEqual({ updatedAt: "updatedAt" });
  expect(fakeIdb.indexKeyPaths(MEAL_PLAN_STORE_NAME)).toEqual({
    date: "date",
    updatedAt: "updatedAt"
  });
  expect(fakeIdb.indexKeyPaths(IMPORT_QUEUE_STORE_NAME)).toEqual({
    createdAt: "createdAt",
    status: "status"
  });
};

describe("linkdish-db v4 schema", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates every store with its indexes on a fresh install", async () => {
    await getLinkDishWebDb();

    expect(LINKDISH_WEB_DB_VERSION).toBe(4);
    expect(fakeIdb.openCalls).toEqual([{ name: "linkdish-web", version: 4 }]);
    expect(fakeIdb.createdStores).toEqual([...LINKDISH_WEB_DB_STORE_NAMES]);
    expectV4Stores();
    expect(fakeIdb.indexKeyPaths(SAVED_RECIPES_STORE_NAME)).toEqual(SAVED_RECIPE_V1_INDEXES);
    expect(fakeIdb.indexKeyPaths(SHOPPING_ITEMS_STORE_NAME)).toEqual(SHOPPING_V3_INDEXES);
    expect(fakeIdb.version).toBe(4);
  });

  it("upgrades v1 data: adds the new stores and moves source images out of recipes", async () => {
    seedExistingSchema(1);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      legacyRecipe("with-scans", { sourceImages: [scan(1), scan(2)] }),
      legacyRecipe("plain")
    ]);

    await getLinkDishWebDb();

    expectV4Stores();
    expect(fakeIdb.createdStores).not.toContain(SAVED_RECIPES_STORE_NAME);
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "with-scans")).toEqual({
      images: [scan(1), scan(2)],
      recipeId: "with-scans",
      updatedAt: "2026-07-02T00:00:00.000Z"
    });

    const migrated = fakeIdb.record<Record<string, unknown>>(
      SAVED_RECIPES_STORE_NAME,
      "with-scans"
    );
    expect(migrated).not.toHaveProperty("sourceImages");
    expect(migrated).toMatchObject({ id: "with-scans", sourceImageCount: 2 });
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "plain")).toEqual(legacyRecipe("plain"));
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "plain")).toBeUndefined();
  });

  it("upgrades v2 records that carry recipe.image", async () => {
    seedExistingSchema(2);
    const withImage = legacyRecipe("v2", {
      recipe: { ...legacyRecipe("v2").recipe, image: { url: "https://example.com/a.jpg" } },
      sourceImages: [scan(3)]
    });
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [withImage]);

    await getLinkDishWebDb();

    expectV4Stores();
    const migrated = fakeIdb.record<Record<string, unknown>>(SAVED_RECIPES_STORE_NAME, "v2");
    expect(migrated).toMatchObject({
      recipe: { image: { url: "https://example.com/a.jpg" } },
      sourceImageCount: 1
    });
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "v2")).toMatchObject({
      images: [scan(3)]
    });
  });

  it("upgrades v3 without touching shopping items", async () => {
    seedExistingSchema(3);
    const shoppingItem = { id: "item-1", sync: { status: "local_only" }, text: "rice" };
    fakeIdb.seed(SHOPPING_ITEMS_STORE_NAME, [shoppingItem]);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      legacyRecipe("scanned", { sourceImages: [scan(4)] }),
      legacyRecipe("empty-scans", { sourceImages: [] }),
      legacyRecipe("plain")
    ]);

    await getLinkDishWebDb();

    expectV4Stores();
    expect(fakeIdb.createdStores).toEqual([
      COLLECTIONS_STORE_NAME,
      MEAL_PLAN_STORE_NAME,
      IMPORT_QUEUE_STORE_NAME,
      COOK_SESSIONS_STORE_NAME,
      RECIPE_SOURCE_IMAGES_STORE_NAME
    ]);
    expect(fakeIdb.records(SHOPPING_ITEMS_STORE_NAME)).toEqual([shoppingItem]);
    expect(fakeIdb.records(RECIPE_SOURCE_IMAGES_STORE_NAME)).toHaveLength(1);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "empty-scans")).toEqual(
      legacyRecipe("empty-scans")
    );
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "plain")).toEqual(legacyRecipe("plain"));
  });

  it("upgrades v3 libraries that have no source images at all", async () => {
    seedExistingSchema(3);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [legacyRecipe("a"), legacyRecipe("b")]);

    await getLinkDishWebDb();

    expect(fakeIdb.records(RECIPE_SOURCE_IMAGES_STORE_NAME)).toEqual([]);
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([
      legacyRecipe("a"),
      legacyRecipe("b")
    ]);
  });

  it("rolls the whole upgrade back when the migration fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seedExistingSchema(3);
    const scanned = legacyRecipe("scanned", { sourceImages: [scan(5)] });
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [scanned]);
    fakeIdb.failNextPut(RECIPE_SOURCE_IMAGES_STORE_NAME, new Error("quota exceeded"));

    await expect(getLinkDishWebDb()).rejects.toMatchObject({ name: "AbortError" });

    expect(consoleError).toHaveBeenCalled();
    expect(fakeIdb.version).toBe(3);
    expect(fakeIdb.hasStore(RECIPE_SOURCE_IMAGES_STORE_NAME)).toBe(false);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "scanned")).toEqual(scanned);
    expect(getLinkDishDbStatus().state).toBe("error");

    // The failed open is not cached: the next attempt runs the upgrade again and succeeds.
    await retryLinkDishWebDb();
    expect(getLinkDishDbStatus().state).toBe("ready");
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "scanned")).toMatchObject({
      images: [scan(5)]
    });
  });
});

describe("source image migration", () => {
  const mapStore = (keyPath: string, map = new Map<string, unknown>()) => {
    const store: MigrationRecordStore & { map: Map<string, unknown>; puts: number } = {
      get: (key) => Promise.resolve(map.get(key as string)),
      getAllKeys: () => Promise.resolve(Array.from(map.keys())),
      map,
      put: (value) => {
        store.puts += 1;
        map.set((value as Record<string, string>)[keyPath] ?? "", value);
        return Promise.resolve();
      },
      puts: 0
    };

    return store;
  };

  it("is idempotent", async () => {
    const recipes = mapStore("id");
    const images = mapStore("recipeId");
    recipes.map.set("r1", legacyRecipe("r1", { sourceImages: [scan(1)] }));
    recipes.map.set("r2", legacyRecipe("r2"));

    await expect(migrateSourceImagesToImageStore(recipes, images)).resolves.toEqual({
      moved: 1,
      stripped: 1
    });
    const afterFirstRun = { images: new Map(images.map), recipes: new Map(recipes.map) };
    const putsAfterFirstRun = recipes.puts + images.puts;

    await expect(migrateSourceImagesToImageStore(recipes, images)).resolves.toEqual({
      moved: 0,
      stripped: 0
    });
    expect(recipes.map).toEqual(afterFirstRun.recipes);
    expect(images.map).toEqual(afterFirstRun.images);
    expect(recipes.puts + images.puts).toBe(putsAfterFirstRun);
  });

  it("copies images before rewriting the recipe", async () => {
    const order: string[] = [];
    const recipes = mapStore("id");
    const images = mapStore("recipeId");
    recipes.map.set("r1", legacyRecipe("r1", { sourceImages: [scan(1)] }));
    const recipePut = recipes.put.bind(recipes);
    const imagePut = images.put.bind(images);
    recipes.put = (value) => {
      order.push("recipe");
      return recipePut(value);
    };
    images.put = (value) => {
      order.push("images");
      return imagePut(value);
    };

    await migrateSourceImagesToImageStore(recipes, images);

    expect(order).toEqual(["images", "recipe"]);
  });

  it("never recreates an existing store", () => {
    const createObjectStore = vi.fn(() => ({ createIndex: vi.fn() }));
    const db = {
      createObjectStore,
      objectStoreNames: { contains: (name: string) => name === SAVED_RECIPES_STORE_NAME }
    };

    expect(ensureObjectStore(db, SAVED_RECIPES_STORE_NAME)).toBe(false);
    expect(ensureObjectStore(db, COLLECTIONS_STORE_NAME)).toBe(true);
    expect(createObjectStore).toHaveBeenCalledTimes(1);
    expect(createObjectStore).toHaveBeenCalledWith(COLLECTIONS_STORE_NAME, { keyPath: "id" });
  });
});

describe("linkdish-db connection lifecycle", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
  });

  it("returns the same connection promise on success", async () => {
    const first = getLinkDishWebDb();
    const second = getLinkDishWebDb();

    expect(second).toBe(first);
    await first;
    expect(getLinkDishWebDb()).toBe(first);
    expect(fakeIdb.openCalls).toHaveLength(1);
    expect(getLinkDishDbStatus()).toEqual({ state: "ready" });
  });

  it("does not cache a rejected open", async () => {
    const failure = new DOMException("disk io", "UnknownError");
    fakeIdb.failNextOpen(failure);

    await expect(getLinkDishWebDb()).rejects.toBe(failure);
    expect(getLinkDishDbStatus()).toEqual({ error: failure, state: "error" });

    await expect(getLinkDishWebDb()).resolves.toBeDefined();
    expect(fakeIdb.openCalls).toHaveLength(2);
    expect(getLinkDishDbStatus().state).toBe("ready");
  });

  it("reports a blocked upgrade and recovers when the older tab lets go", async () => {
    const states: string[] = [];
    const unsubscribe = subscribeLinkDishDbStatus(() => {
      states.push(getLinkDishDbStatus().state);
    });
    fakeIdb.blockNextOpen();

    await getLinkDishWebDb();
    unsubscribe();

    expect(states).toEqual(["opening", "blocked", "ready"]);
  });

  it("closes its connection for a newer tab and reopens on retry", async () => {
    const first = await getLinkDishWebDb();

    fakeIdb.fireBlocking(5);

    expect(getLinkDishDbStatus().state).toBe("outdated");
    const reopened = await retryLinkDishWebDb();
    expect(reopened).not.toBe(first);
    expect(fakeIdb.openCalls).toHaveLength(2);
  });

  it("treats a newer on-disk schema as outdated code", async () => {
    fakeIdb.reset(LINKDISH_WEB_DB_VERSION + 1);

    await expect(getLinkDishWebDb()).rejects.toMatchObject({ name: "VersionError" });
    expect(getLinkDishDbStatus().state).toBe("outdated");
  });

  it("reopens after the browser terminates the connection", async () => {
    await getLinkDishWebDb();

    fakeIdb.fireTerminated();

    expect(getLinkDishDbStatus().state).toBe("terminated");
    await getLinkDishWebDb();
    expect(fakeIdb.openCalls).toHaveLength(2);
    expect(getLinkDishDbStatus().state).toBe("ready");
  });
});
