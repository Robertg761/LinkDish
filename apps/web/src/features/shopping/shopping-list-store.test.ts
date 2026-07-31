import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";

import {
  addShoppingItems,
  getShoppingItems,
  handleUpsertShoppingSyncResult,
  mergeShoppingItems,
  setShoppingItemChecked,
  type WebShoppingItem
} from "./shopping-list-store";

const idbMocks = vi.hoisted(() => ({
  createObjectStore: vi.fn(),
  oldVersion: 2,
  openDB: vi.fn(),
  stores: new Map<string, Map<string, unknown>>()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    deleteShoppingItems: vi.fn(),
    getShoppingList: vi.fn(),
    upsertShoppingItems: vi.fn()
  }
}));

vi.mock("idb", () => {
  const getStore = (name: string) => {
    let store = idbMocks.stores.get(name);

    if (!store) {
      store = new Map<string, unknown>();
      idbMocks.stores.set(name, store);
    }

    return store;
  };

  return {
    openDB: idbMocks.openDB.mockImplementation(
      async (
        _name: string,
        _version: number,
        options?: {
          upgrade?: (
            db: {
              createObjectStore: ReturnType<typeof vi.fn>;
              objectStoreNames: { contains: (name: string) => boolean };
            },
            oldVersion: number,
            newVersion: number,
            transaction: never
          ) => void;
        }
      ) => {
        await Promise.resolve();
        const db = {
          createObjectStore: idbMocks.createObjectStore.mockImplementation((name: string) => {
            getStore(name);
            return { createIndex: vi.fn() };
          }),
          objectStoreNames: {
            contains: (name: string) => idbMocks.stores.has(name)
          },
          transaction: (storeName: string) => ({
            objectStore: () => ({
              get: async (key: string) => {
                await Promise.resolve();
                return getStore(storeName).get(key);
              },
              getAll: async () => {
                await Promise.resolve();
                return Array.from(getStore(storeName).values());
              },
              put: async (value: unknown) => {
                await Promise.resolve();
                getStore(storeName).set((value as { id: string }).id, value);
              }
            })
          }),
          delete: async (storeName: string, key: string) => {
            await Promise.resolve();
            getStore(storeName).delete(key);
          },
          get: async (storeName: string, key: string) => {
            await Promise.resolve();
            return getStore(storeName).get(key);
          },
          getAll: async (storeName: string) => {
            await Promise.resolve();
            return Array.from(getStore(storeName).values());
          },
          put: async (storeName: string, value: unknown) => {
            await Promise.resolve();
            getStore(storeName).set((value as { id: string }).id, value);
          }
        };

        options?.upgrade?.(db, idbMocks.oldVersion, _version, {} as never);
        return db;
      }
    )
  };
});

const makeItem = (overrides: Partial<WebShoppingItem>): WebShoppingItem => ({
  addedBy: "user-1",
  checked: false,
  checkedBy: null,
  createdAt: "2026-07-04T10:00:00.000Z",
  id: overrides.id ?? "item-1",
  sync: { status: "dirty" },
  text: "sugar",
  updatedAt: "2026-07-04T10:00:00.000Z",
  ...overrides
});

describe("shopping-list-store", () => {
  beforeEach(() => {
    idbMocks.createObjectStore.mockClear();
    idbMocks.openDB.mockClear();
    idbMocks.oldVersion = 2;
    idbMocks.stores.clear();
    resetLinkDishWebDbForTests();

    let uuidIndex = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuidIndex += 1;
      return `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, "0")}`;
    });
  });

  it("creates the shopping object store during the v3 migration", async () => {
    await getShoppingItems();

    expect(idbMocks.openDB).toHaveBeenCalledWith("linkdish-web", 3, expect.any(Object));
    expect(idbMocks.createObjectStore).toHaveBeenCalledWith("shoppingItems", { keyPath: "id" });
  });

  it("round-trips local-only shopping items through IndexedDB", async () => {
    await addShoppingItems([{ text: "1 cup sugar" }], { canSync: false });

    const items = await getShoppingItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      qty: 1,
      sync: { status: "local_only" },
      text: "sugar",
      unit: "cup"
    });
  });

  it("merges identical item text only when units match", () => {
    const merged = mergeShoppingItems(
      [makeItem({ id: "cup-sugar", qty: 1, text: "sugar", unit: "cup" })],
      [
        makeItem({ id: "more-cup-sugar", qty: 2, text: "Sugar", unit: "cup" }),
        makeItem({ id: "gram-sugar", qty: 100, text: "sugar", unit: "g" })
      ]
    );

    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === "cup-sugar")?.qty).toBe(3);
    expect(merged.find((item) => item.id === "gram-sugar")?.qty).toBe(100);
  });

  it("moves check-off state between unchecked and checked with dirty sync status", async () => {
    await addShoppingItems([{ text: "olive oil" }], { canSync: true, userId: "user-1" });

    const checked = await setShoppingItemChecked("00000000-0000-4000-8000-000000000001", true, {
      canSync: true,
      userId: "user-1"
    });
    const unchecked = await setShoppingItemChecked("00000000-0000-4000-8000-000000000001", false, {
      canSync: true,
      userId: "user-1"
    });

    expect(checked).toMatchObject({
      checked: true,
      checkedBy: "user-1",
      sync: { status: "dirty" }
    });
    expect(unchecked).toMatchObject({
      checked: false,
      checkedBy: null,
      sync: { status: "dirty" }
    });
  });

  it("keeps ignored LWW upserts out of the synced state", async () => {
    await addShoppingItems([{ text: "2 cups flour" }], { canSync: true, userId: "user-1" });

    await handleUpsertShoppingSyncResult({
      ignored: [
        {
          existingUpdatedAt: "2026-07-04T10:05:00.000Z",
          id: "00000000-0000-4000-8000-000000000001",
          reason: "older_update"
        }
      ],
      items: []
    });

    const [item] = await getShoppingItems();
    expect(item?.sync).toMatchObject({
      lastError: "Household has a newer copy. Refresh to pull it in.",
      status: "sync_failed"
    });
  });
});
