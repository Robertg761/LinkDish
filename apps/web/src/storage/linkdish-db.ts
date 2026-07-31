import { openDB, type IDBPDatabase } from "idb";

export const LINKDISH_WEB_DB_NAME = "linkdish-web";
export const LINKDISH_WEB_DB_VERSION = 3;
export const SAVED_RECIPES_STORE_NAME = "savedRecipes";
export const SHOPPING_ITEMS_STORE_NAME = "shoppingItems";

let dbPromise: Promise<IDBPDatabase> | null = null;

const createSavedRecipesStore = (db: IDBPDatabase): void => {
  if (db.objectStoreNames.contains(SAVED_RECIPES_STORE_NAME)) {
    return;
  }

  const store = db.createObjectStore(SAVED_RECIPES_STORE_NAME, { keyPath: "id" });
  store.createIndex("updatedAt", "updatedAt", { unique: false });
  store.createIndex("createdAt", "createdAt", { unique: false });
  store.createIndex("title", "recipe.title", { unique: false });
  store.createIndex("sourceHost", "sourceHost", { unique: false });
};

const createShoppingItemsStore = (db: IDBPDatabase): void => {
  if (db.objectStoreNames.contains(SHOPPING_ITEMS_STORE_NAME)) {
    return;
  }

  const store = db.createObjectStore(SHOPPING_ITEMS_STORE_NAME, { keyPath: "id" });
  store.createIndex("updatedAt", "updatedAt", { unique: false });
  store.createIndex("recipeTitle", "recipeTitle", { unique: false });
  store.createIndex("checked", "checked", { unique: false });
  store.createIndex("syncStatus", "sync.status", { unique: false });
};

export function getLinkDishWebDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(LINKDISH_WEB_DB_NAME, LINKDISH_WEB_DB_VERSION, {
      upgrade(db, oldVersion) {
        createSavedRecipesStore(db);

        if (oldVersion < 2) {
          // v2 stores recipe.image inside the existing recipe payload.
        }

        if (oldVersion < 3) {
          createShoppingItemsStore(db);
        }
      }
    });
  }

  return dbPromise;
}

export function resetLinkDishWebDbForTests(): void {
  dbPromise = null;
}
