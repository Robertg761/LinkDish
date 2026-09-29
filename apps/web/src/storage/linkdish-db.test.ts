import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLLECTIONS_STORE_NAME,
  COOK_SESSIONS_STORE_NAME,
  ensureObjectStore,
  finishSourceImageMigration,
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
  SOURCE_IMAGE_MIGRATION_PENDING_KEY,
  subscribeLinkDishDbStatus,
  type MigrationDatabase,
  type MigrationRecordStore
} from "./linkdish-db";
import { fakeIdb } from "./testing/fake-idb";

/**
 * Every connection the fake opens, wrapped so it behaves like a real IndexedDB connection once
 * closed: `close()` is recorded and later transactions throw `InvalidStateError`.
 */
const connections = vi.hoisted(() => ({
  /** Runs once, when the next `getAllKeys` has read its keys and before it answers. */
  afterNextGetAllKeys: null as (() => Promise<void> | void) | null,
  /** Connections this page closed with `close()`. */
  closed: new Set<object>(),
  /** Connections the browser closed on its own (they fire `terminated`, not `close()`). */
  lost: new Set<object>(),
  opened: [] as object[],
  reset(): void {
    connections.afterNextGetAllKeys = null;
    connections.closed = new Set();
    connections.lost = new Set();
    connections.opened = [];
  }
}));

vi.mock("idb", async () => {
  const { fakeIdbModule } = await import("./testing/fake-idb");

  return {
    ...fakeIdbModule,
    openDB: async (...args: Parameters<typeof fakeIdbModule.openDB>) => {
      const db = await fakeIdbModule.openDB(...args);
      const assertOpen = () => {
        if (connections.closed.has(connection) || connections.lost.has(connection)) {
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        }
      };
      const connection = {
        ...db,
        close: () => {
          connections.closed.add(connection);
          db.close();
        },
        getAllKeys: async (storeName: string) => {
          assertOpen();
          const keys = await db.getAllKeys(storeName);
          const afterGetAllKeys = connections.afterNextGetAllKeys;
          connections.afterNextGetAllKeys = null;
          await afterGetAllKeys?.();
          return keys;
        },
        transaction: (...transactionArgs: Parameters<typeof db.transaction>) => {
          assertOpen();
          return db.transaction(...transactionArgs);
        }
      };

      connections.opened.push(connection);
      return connection;
    }
  };
});

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
    connections.reset();
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

  it("still opens when moving the scans fails (a full device), and finishes the move later", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedExistingSchema(3);
    const scanned = legacyRecipe("scanned", { sourceImages: [scan(5)] });
    const other = legacyRecipe("other", { sourceImages: [scan(6)] });
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [scanned, other]);
    fakeIdb.failNextPut(
      RECIPE_SOURCE_IMAGES_STORE_NAME,
      new DOMException("The quota has been exceeded.", "QuotaExceededError")
    );

    await getLinkDishWebDb();

    // Not locked out: the schema is upgraded and every recipe (with its scans) is still there.
    expect(consoleWarn).toHaveBeenCalled();
    expect(getLinkDishDbStatus().state).toBe("ready");
    expect(fakeIdb.version).toBe(4);
    expectV4Stores();
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "scanned")).toEqual(scanned);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "other")).toEqual(other);

    // The next load (with room again) moves them.
    resetLinkDishWebDbForTests();
    await getLinkDishWebDb();

    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "scanned")).toMatchObject({
      images: [scan(5)]
    });
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "scanned")).not.toHaveProperty("sourceImages");
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "other")).toMatchObject({
      sourceImageCount: 1
    });
    expect(localStorage.getItem(SOURCE_IMAGE_MIGRATION_PENDING_KEY)).toBeNull();
  });

  it("moves each recipe's scans in its own transaction", async () => {
    const db = await getLinkDishWebDb();
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      legacyRecipe("a", { sourceImages: [scan(1)] }),
      legacyRecipe("b", { sourceImages: [scan(2)] })
    ]);
    const transactions: string[][] = [];
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(((names: string[], mode: "readwrite") => {
      transactions.push(names);
      return transaction(names, mode);
    }) as typeof db.transaction);

    await expect(finishSourceImageMigration(db as unknown as MigrationDatabase)).resolves.toBe(
      true
    );

    expect(transactions).toHaveLength(2);
    expect(fakeIdb.records(RECIPE_SOURCE_IMAGES_STORE_NAME)).toHaveLength(2);
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
    connections.reset();
    localStorage.removeItem(SOURCE_IMAGE_MIGRATION_PENDING_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seedScannedLibrary = () => {
    seedExistingSchema(3);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      legacyRecipe("a", { sourceImages: [scan(1)] }),
      legacyRecipe("b", { sourceImages: [scan(2)] })
    ]);
  };

  const recordStates = () => {
    const states: string[] = [];
    const unsubscribe = subscribeLinkDishDbStatus(() => {
      states.push(getLinkDishDbStatus().state);
    });

    return { states, unsubscribe };
  };

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
    expect(connections.closed.has(first)).toBe(true);
    const reopened = await retryLinkDishWebDb();
    expect(reopened).not.toBe(first);
    expect(connections.closed.has(reopened)).toBe(false);
    expect(fakeIdb.openCalls).toHaveLength(2);
  });

  it("closes its connection for a newer tab even while it is still moving scans", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedScannedLibrary();
    const { states, unsubscribe } = recordStates();
    // A newer deployment asks to upgrade while the post-open migration is awaiting storage.
    connections.afterNextGetAllKeys = () => {
      fakeIdb.fireBlocking(5);
    };

    const outcome = await getLinkDishWebDb().then(
      (db) => db,
      (error: unknown) => error
    );
    unsubscribe();

    // The real connection is closed (not left open to block the newer tab), and never "ready".
    const [connection] = connections.opened;
    expect(connection).toBeDefined();
    expect(connections.closed.has(connection as object)).toBe(true);
    expect(states).toEqual(["opening", "outdated"]);
    expect(outcome).toMatchObject({ name: "InvalidStateError" });
    // The move stopped where it was; recipes keep their scans and the next load finishes it.
    expect(consoleWarn).toHaveBeenCalled();
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "a")).toHaveProperty("sourceImages");
    expect(localStorage.getItem(SOURCE_IMAGE_MIGRATION_PENDING_KEY)).not.toBeNull();
  });

  it("leaves a reopened connection alone when the replaced one finishes its migration", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedScannedLibrary();
    let resumeFirstMigration: () => void = () => undefined;
    connections.afterNextGetAllKeys = () => {
      fakeIdb.fireBlocking(5);
      return new Promise<void>((resolve) => {
        resumeFirstMigration = resolve;
      });
    };

    const first = getLinkDishWebDb();
    first.catch(() => undefined);
    await vi.waitFor(() => {
      expect(getLinkDishDbStatus().state).toBe("outdated");
    });

    // The newer tab gave up; this tab reconnects while the replaced connection is still migrating.
    const second = await retryLinkDishWebDb();
    expect(getLinkDishDbStatus().state).toBe("ready");

    resumeFirstMigration();
    await expect(first).rejects.toMatchObject({ name: "InvalidStateError" });

    const [firstConnection] = connections.opened;
    expect(connections.opened).toHaveLength(2);
    expect(connections.closed.has(firstConnection as object)).toBe(true);
    expect(connections.closed.has(second)).toBe(false);
    expect(getLinkDishDbStatus().state).toBe("ready");
    await expect(getLinkDishWebDb()).resolves.toBe(second);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "a")).not.toHaveProperty("sourceImages");
  });

  it("hands out no connection the browser closed while it was still moving scans", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    seedScannedLibrary();
    connections.afterNextGetAllKeys = () => {
      connections.lost.add(connections.opened[0] as object);
      fakeIdb.fireTerminated();
    };

    await expect(getLinkDishWebDb()).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(getLinkDishDbStatus().state).toBe("terminated");
    expect(localStorage.getItem(SOURCE_IMAGE_MIGRATION_PENDING_KEY)).not.toBeNull();

    const reopened = await getLinkDishWebDb();
    expect(connections.opened).toEqual([expect.anything(), reopened]);
    expect(connections.closed.has(reopened)).toBe(false);
    expect(getLinkDishDbStatus().state).toBe("ready");
    expect(localStorage.getItem(SOURCE_IMAGE_MIGRATION_PENDING_KEY)).toBeNull();
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
