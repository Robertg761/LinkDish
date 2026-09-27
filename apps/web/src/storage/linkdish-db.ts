import { openDB, type IDBPDatabase } from "idb";

export const LINKDISH_WEB_DB_NAME = "linkdish-web";
export const LINKDISH_WEB_DB_VERSION = 4;
export const SAVED_RECIPES_STORE_NAME = "savedRecipes";
export const SHOPPING_ITEMS_STORE_NAME = "shoppingItems";
export const COLLECTIONS_STORE_NAME = "collections";
export const MEAL_PLAN_STORE_NAME = "mealPlan";
export const IMPORT_QUEUE_STORE_NAME = "importQueue";
export const COOK_SESSIONS_STORE_NAME = "cookSessions";
export const RECIPE_SOURCE_IMAGES_STORE_NAME = "recipeSourceImages";

/** Every object store the current schema defines, in creation order. */
export const LINKDISH_WEB_DB_STORE_NAMES = [
  SAVED_RECIPES_STORE_NAME,
  SHOPPING_ITEMS_STORE_NAME,
  COLLECTIONS_STORE_NAME,
  MEAL_PLAN_STORE_NAME,
  IMPORT_QUEUE_STORE_NAME,
  COOK_SESSIONS_STORE_NAME,
  RECIPE_SOURCE_IMAGES_STORE_NAME
] as const;

export type LinkDishWebStoreName = (typeof LINKDISH_WEB_DB_STORE_NAMES)[number];

/* ------------------------------------------------------------------------------------------------
 * Upgrade logic
 *
 * The schema upgrade is written against the small structural interfaces below instead of idb's
 * types so it can be unit tested with Map-backed fakes (there is no fake-indexeddb in this repo).
 * Real idb objects satisfy these interfaces.
 * ---------------------------------------------------------------------------------------------- */

export interface UpgradeObjectStore {
  createIndex(name: string, keyPath: string | string[], options?: IDBIndexParameters): unknown;
}

export interface UpgradeDatabase {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: IDBObjectStoreParameters): UpgradeObjectStore;
}

/** The subset of an object store the data migrations use. Only IDB requests are awaited. */
export interface MigrationRecordStore {
  getAllKeys(): Promise<IDBValidKey[]>;
  get(key: IDBValidKey): Promise<unknown>;
  put(value: unknown): Promise<unknown>;
}

export interface UpgradeTransaction {
  objectStore(name: string): MigrationRecordStore;
}

interface StoreDefinition {
  indexes: Array<{ keyPath: string; name: string }>;
  keyPath: string;
  name: LinkDishWebStoreName;
}

const STORE_DEFINITIONS: Record<LinkDishWebStoreName, StoreDefinition> = {
  [SAVED_RECIPES_STORE_NAME]: {
    indexes: [
      { keyPath: "updatedAt", name: "updatedAt" },
      { keyPath: "createdAt", name: "createdAt" },
      { keyPath: "recipe.title", name: "title" },
      { keyPath: "sourceHost", name: "sourceHost" }
    ],
    keyPath: "id",
    name: SAVED_RECIPES_STORE_NAME
  },
  [SHOPPING_ITEMS_STORE_NAME]: {
    indexes: [
      { keyPath: "updatedAt", name: "updatedAt" },
      { keyPath: "recipeTitle", name: "recipeTitle" },
      { keyPath: "checked", name: "checked" },
      { keyPath: "sync.status", name: "syncStatus" }
    ],
    keyPath: "id",
    name: SHOPPING_ITEMS_STORE_NAME
  },
  [COLLECTIONS_STORE_NAME]: {
    indexes: [{ keyPath: "updatedAt", name: "updatedAt" }],
    keyPath: "id",
    name: COLLECTIONS_STORE_NAME
  },
  [MEAL_PLAN_STORE_NAME]: {
    indexes: [
      { keyPath: "date", name: "date" },
      { keyPath: "updatedAt", name: "updatedAt" }
    ],
    keyPath: "id",
    name: MEAL_PLAN_STORE_NAME
  },
  [IMPORT_QUEUE_STORE_NAME]: {
    indexes: [
      { keyPath: "createdAt", name: "createdAt" },
      { keyPath: "status", name: "status" }
    ],
    keyPath: "id",
    name: IMPORT_QUEUE_STORE_NAME
  },
  [COOK_SESSIONS_STORE_NAME]: {
    indexes: [],
    keyPath: "recipeId",
    name: COOK_SESSIONS_STORE_NAME
  },
  [RECIPE_SOURCE_IMAGES_STORE_NAME]: {
    indexes: [],
    keyPath: "recipeId",
    name: RECIPE_SOURCE_IMAGES_STORE_NAME
  }
};

/** Creates a store (and its indexes) unless it already exists. Never deletes or recreates. */
export const ensureObjectStore = (db: UpgradeDatabase, name: LinkDishWebStoreName): boolean => {
  if (db.objectStoreNames.contains(name)) {
    return false;
  }

  const definition = STORE_DEFINITIONS[name];
  const store = db.createObjectStore(name, { keyPath: definition.keyPath });

  for (const index of definition.indexes) {
    store.createIndex(index.name, index.keyPath, { unique: false });
  }

  return true;
};

/** Shape of a record in the `recipeSourceImages` store. */
export interface StoredRecipeSourceImages<Image = unknown> {
  images: Image[];
  recipeId: string;
  updatedAt: string;
}

export interface SourceImageMigrationResult {
  /** Recipes whose images were copied into the images store. */
  moved: number;
  /** Recipe records rewritten without an embedded `sourceImages` field. */
  stripped: number;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * v4 perf migration: moves `sourceImages` (multi-MB base64 data URLs) out of each saved recipe
 * into the `recipeSourceImages` store so list reads stop cloning them.
 *
 * Per record the images are written first and the recipe is rewritten second. Everything runs in
 * the single versionchange transaction, so if any step throws the caller aborts the transaction
 * and the database stays exactly as it was. Running it again is a no-op.
 */
export async function migrateSourceImagesToImageStore(
  savedRecipes: MigrationRecordStore,
  sourceImages: MigrationRecordStore,
  now: () => string = () => new Date().toISOString()
): Promise<SourceImageMigrationResult> {
  const result: SourceImageMigrationResult = { moved: 0, stripped: 0 };
  const keys = await savedRecipes.getAllKeys();

  for (const key of keys) {
    const record = await savedRecipes.get(key);

    if (!isPlainRecord(record) || !("sourceImages" in record)) {
      continue;
    }

    const { sourceImages: embeddedImages, ...rest } = record;
    const images = Array.isArray(embeddedImages) ? (embeddedImages as unknown[]) : [];

    if (images.length > 0) {
      const imageRecord: StoredRecipeSourceImages = {
        images,
        recipeId: typeof key === "string" ? key : String(key as number),
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now()
      };

      await sourceImages.put(imageRecord);
      result.moved += 1;
    }

    await savedRecipes.put(images.length > 0 ? { ...rest, sourceImageCount: images.length } : rest);
    result.stripped += 1;
  }

  return result;
}

/**
 * Runs every schema step needed to bring `oldVersion` up to {@link LINKDISH_WEB_DB_VERSION}.
 * Store creation is idempotent and additive; data migrations are oldVersion-gated.
 */
export async function runLinkDishWebDbUpgrade(
  db: UpgradeDatabase,
  oldVersion: number,
  transaction: UpgradeTransaction
): Promise<void> {
  // v1: saved recipes. v2 only added recipe.image inside the existing payload.
  ensureObjectStore(db, SAVED_RECIPES_STORE_NAME);

  if (oldVersion < 3) {
    ensureObjectStore(db, SHOPPING_ITEMS_STORE_NAME);
  }

  if (oldVersion < 4) {
    ensureObjectStore(db, COLLECTIONS_STORE_NAME);
    ensureObjectStore(db, MEAL_PLAN_STORE_NAME);
    ensureObjectStore(db, IMPORT_QUEUE_STORE_NAME);
    ensureObjectStore(db, COOK_SESSIONS_STORE_NAME);
    ensureObjectStore(db, RECIPE_SOURCE_IMAGES_STORE_NAME);

    if (oldVersion > 0) {
      await migrateSourceImagesToImageStore(
        transaction.objectStore(SAVED_RECIPES_STORE_NAME),
        transaction.objectStore(RECIPE_SOURCE_IMAGES_STORE_NAME)
      );
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Connection management
 * ---------------------------------------------------------------------------------------------- */

export type LinkDishDbStatus =
  | { state: "idle" }
  | { state: "opening" }
  | { state: "ready" }
  /** An older tab still holds the database open, so the upgrade is waiting. */
  | { state: "blocked" }
  /** This tab is running older code than the database (another tab upgraded it). Reload. */
  | { state: "outdated" }
  /** The browser closed the connection (e.g. storage cleared). Retry reopens it. */
  | { state: "terminated" }
  | { state: "error"; error: unknown };

let dbPromise: Promise<IDBPDatabase> | null = null;
let openDbConnection: IDBPDatabase | null = null;
let status: LinkDishDbStatus = { state: "idle" };
const statusListeners = new Set<() => void>();

const setStatus = (next: LinkDishDbStatus): void => {
  status = next;
  statusListeners.forEach((listener) => {
    listener();
  });
};

const closeConnection = (connection: IDBPDatabase | null): void => {
  try {
    connection?.close();
  } catch {
    // Closing an already-closed connection is harmless.
  }
};

const isVersionError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name?: unknown }).name === "VersionError";

/**
 * Returns the shared `linkdish-web` connection. Successful opens are cached as a singleton;
 * a failed open is never cached, so the next call (or {@link retryLinkDishWebDb}) tries again.
 */
export function getLinkDishWebDb(): Promise<IDBPDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  setStatus({ state: "opening" });

  const promise: Promise<IDBPDatabase> = openDB(LINKDISH_WEB_DB_NAME, LINKDISH_WEB_DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      runLinkDishWebDbUpgrade(
        db as unknown as UpgradeDatabase,
        oldVersion,
        transaction as unknown as UpgradeTransaction
      ).catch((error: unknown) => {
        console.error("LinkDish storage upgrade failed; keeping the previous data.", error);

        try {
          // Aborting the versionchange transaction rolls back every step of the upgrade.
          (transaction as unknown as { abort?: () => void }).abort?.();
        } catch {
          // The transaction may already be finished or aborted.
        }
      });
    },
    blocked() {
      setStatus({ state: "blocked" });
    },
    blocking() {
      // A newer LinkDish tab wants to upgrade the schema. Step aside so it can, then ask this
      // (older) tab to reload instead of hanging the other one.
      const connection = openDbConnection;
      openDbConnection = null;
      dbPromise = null;
      closeConnection(connection);
      setStatus({ state: "outdated" });
    },
    terminated() {
      openDbConnection = null;
      dbPromise = null;
      setStatus({ state: "terminated" });
    }
  }).then(
    (db) => {
      if (dbPromise === promise) {
        openDbConnection = db;
        setStatus({ state: "ready" });
      }

      return db;
    },
    (error: unknown) => {
      if (dbPromise === promise) {
        dbPromise = null;
        setStatus(isVersionError(error) ? { state: "outdated" } : { state: "error", error });
      }

      throw error;
    }
  );

  dbPromise = promise;
  return promise;
}

/** Drops a failed or terminated connection and opens again. Safe to call at any time. */
export function retryLinkDishWebDb(): Promise<IDBPDatabase> {
  if (status.state === "error" || status.state === "terminated" || status.state === "outdated") {
    dbPromise = null;
  }

  return getLinkDishWebDb();
}

export function getLinkDishDbStatus(): LinkDishDbStatus {
  return status;
}

export function subscribeLinkDishDbStatus(listener: () => void): () => void {
  statusListeners.add(listener);

  return () => {
    statusListeners.delete(listener);
  };
}

export function resetLinkDishWebDbForTests(): void {
  closeConnection(openDbConnection);
  openDbConnection = null;
  dbPromise = null;
  status = { state: "idle" };
}
