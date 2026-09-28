import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accountState = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(),
  isSignedIn: false,
  user: null as { email: string; id: string } | null
}));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  createExtractorApiClient: vi.fn()
}));

const appStateMocks = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("@linkdish/api-client", () => ({
  ExtractorApiError: class ExtractorApiError extends Error {},
  createExtractorApiClient: apiMocks.createExtractorApiClient
}));

vi.mock("../../analytics/client", () => ({
  trackMobileEvent: vi.fn()
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMocks.listeners.push(listener);
      return {
        remove: () => {
          appStateMocks.listeners = appStateMocks.listeners.filter((entry) => entry !== listener);
        }
      };
    }
  }
}));

import {
  SHOPPING_PERSIST_DEBOUNCE_MS,
  SHOPPING_SYNC_DEBOUNCE_MS,
  ShoppingListProvider,
  useShoppingList
} from "./ShoppingListContext";

import type { ShoppingItem } from "@linkdish/recipe-domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latestShoppingList: ReturnType<typeof useShoppingList> | null = null;

const Probe = () => {
  latestShoppingList = useShoppingList();
  return null;
};

const flushAsyncWork = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const renderProvider = async () => {
  let renderer: ReturnType<typeof create> | undefined;

  await act(async () => {
    renderer = create(
      <ShoppingListProvider>
        <Probe />
      </ShoppingListProvider>
    );
    await flushAsyncWork();
  });

  await act(async () => {
    await flushAsyncWork();
  });

  return renderer!;
};

const shoppingWrites = () =>
  asyncStorageMocks.setItem.mock.calls
    .filter(([key]) => key === "linkdish.shoppingItems.v1")
    .map(([, value]) => String(value));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
};

const buildClient = () => ({
  deleteShoppingItems: vi
    .fn()
    .mockResolvedValue({ deletedItemIds: [], ignored: [], status: "deleted" }),
  getHousehold: vi.fn().mockResolvedValue({ household: null }),
  getShoppingList: vi.fn().mockResolvedValue({ items: [] }),
  upsertShoppingItems: vi.fn(({ items }: { items: ShoppingItem[] }) =>
    Promise.resolve({ ignored: [], items })
  )
});

describe("ShoppingListProvider storage recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestShoppingList = null;
    appStateMocks.listeners = [];
    accountState.getAuthHeaders.mockReset();
    accountState.getAuthHeaders.mockResolvedValue({});
    accountState.isSignedIn = false;
    accountState.user = null;
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.removeItem.mockReset();
    asyncStorageMocks.removeItem.mockResolvedValue(undefined);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    apiMocks.createExtractorApiClient.mockReset();
    apiMocks.createExtractorApiClient.mockReturnValue(buildClient());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not overwrite a corrupt shopping list with an empty one", async () => {
    const corruptBlob = '[{"id":"item_1","text":"Milk"';
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.shoppingItems.v1" ? corruptBlob : null)
    );

    await renderProvider();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOPPING_PERSIST_DEBOUNCE_MS);
    });

    expect(latestShoppingList?.hasLoadedShoppingItems).toBe(true);
    expect(latestShoppingList?.shoppingItems).toHaveLength(0);
    expect(shoppingWrites()).toHaveLength(0);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.shoppingItems.corrupt.v1",
      corruptBlob
    );

    await act(async () => {
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "Milk" }]);
      await flushAsyncWork();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOPPING_PERSIST_DEBOUNCE_MS);
    });

    expect(shoppingWrites().length).toBeGreaterThan(0);
  });

  it("persists a readable shopping list once edits settle", async () => {
    await renderProvider();

    await act(async () => {
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "Eggs" }]);
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "Flour" }]);
      await flushAsyncWork();
    });

    const writesBeforeDebounce = shoppingWrites().filter((value) => value.includes("Eggs"));
    expect(writesBeforeDebounce).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOPPING_PERSIST_DEBOUNCE_MS);
    });

    const writes = shoppingWrites();
    expect(writes.filter((value) => value.includes("Eggs"))).toHaveLength(1);
    expect(writes[writes.length - 1]).toContain("Flour");
  });

  it("writes pending edits immediately when the app goes to the background", async () => {
    await renderProvider();

    await act(async () => {
      latestShoppingList!.addItems([{ text: "Butter" }]);
      await flushAsyncWork();
    });

    expect(shoppingWrites().some((value) => value.includes("Butter"))).toBe(false);

    await act(async () => {
      appStateMocks.listeners.forEach((listener) => listener("background"));
      await flushAsyncWork();
    });

    expect(shoppingWrites().some((value) => value.includes("Butter"))).toBe(true);
  });

  it("keeps a stable value when an unrelated render happens", async () => {
    const renderer = await renderProvider();
    const firstValue = latestShoppingList;

    await act(async () => {
      renderer.update(
        <ShoppingListProvider>
          <Probe />
        </ShoppingListProvider>
      );
      await flushAsyncWork();
    });

    expect(latestShoppingList).toBe(firstValue);
    expect(latestShoppingList?.addItems).toBe(firstValue?.addItems);
  });
});

describe("ShoppingListProvider household sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latestShoppingList = null;
    appStateMocks.listeners = [];
    accountState.getAuthHeaders.mockReset();
    accountState.getAuthHeaders.mockResolvedValue({});
    accountState.isSignedIn = true;
    accountState.user = { email: "cook@example.com", id: "user_1" };
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues a follow-up push for an edit made while a refresh is in flight", async () => {
    const client = buildClient();
    const firstList = createDeferred<{ items: ShoppingItem[] }>();
    client.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    client.getShoppingList.mockReturnValueOnce(firstList.promise).mockResolvedValue({ items: [] });
    apiMocks.createExtractorApiClient.mockReturnValue(client);

    await renderProvider();

    // The initial refresh is waiting on getShoppingList.
    expect(client.getShoppingList).toHaveBeenCalledTimes(1);

    await act(async () => {
      latestShoppingList!.addItems([{ text: "2 onions" }]);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
    });

    // Before the fix this push was dropped until the next focus or foreground.
    expect(client.upsertShoppingItems).not.toHaveBeenCalled();

    await act(async () => {
      firstList.resolve({ items: [] });
      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(client.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(client.upsertShoppingItems.mock.calls[0]?.[0].items[0]).toMatchObject({
      qty: 2,
      text: "onions"
    });
    expect(latestShoppingList?.shoppingItems[0]?.sync.status).toBe("synced");
  });

  it("coalesces rapid check-offs into one push and reuses the cached household id", async () => {
    const client = buildClient();
    client.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    const now = "2026-07-04T12:00:00.000Z";
    client.getShoppingList.mockResolvedValue({
      items: [
        { addedBy: "user_1", checked: false, id: "a", text: "milk", updatedAt: now },
        { addedBy: "user_1", checked: false, id: "b", text: "eggs", updatedAt: now },
        { addedBy: "user_1", checked: false, id: "c", text: "bread", updatedAt: now }
      ]
    });
    apiMocks.createExtractorApiClient.mockReturnValue(client);

    await renderProvider();

    expect(client.getHousehold).toHaveBeenCalledTimes(1);
    expect(latestShoppingList?.canSyncShoppingList).toBe(true);
    expect(latestShoppingList?.shoppingItems).toHaveLength(3);

    await act(async () => {
      latestShoppingList!.setItemChecked("a", true);
      latestShoppingList!.setItemChecked("b", true);
      latestShoppingList!.setItemChecked("c", true);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });

    expect(client.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(client.upsertShoppingItems.mock.calls[0]?.[0].items).toHaveLength(3);
    expect(client.getHousehold).toHaveBeenCalledTimes(1);
    expect(client.getShoppingList).toHaveBeenCalledTimes(1);
    expect(latestShoppingList?.shoppingItems.every((item) => item.sync.status === "synced")).toBe(
      true
    );
  });

  it("marks pushed items synced when the server echoes the same version", async () => {
    const client = buildClient();
    client.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    apiMocks.createExtractorApiClient.mockReturnValue(client);

    await renderProvider();

    await act(async () => {
      latestShoppingList!.addItems([{ text: "Salt" }]);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });

    expect(client.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(latestShoppingList?.shoppingItems[0]?.sync.status).toBe("synced");

    // Nothing is dirty anymore, so a later refresh pulls without re-pushing.
    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });

    expect(client.upsertShoppingItems).toHaveBeenCalledTimes(1);
  });

  it("clears checked items as one synced delete", async () => {
    const client = buildClient();
    const now = "2026-07-04T12:00:00.000Z";
    client.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    client.getShoppingList.mockResolvedValueOnce({
      items: [
        { addedBy: "user_1", checked: true, id: "a", text: "milk", updatedAt: now },
        { addedBy: "user_1", checked: false, id: "b", text: "eggs", updatedAt: now }
      ]
    });
    client.deleteShoppingItems.mockResolvedValue({
      deletedItemIds: ["a"],
      ignored: [],
      status: "deleted"
    });
    apiMocks.createExtractorApiClient.mockReturnValue(client);

    await renderProvider();

    await act(async () => {
      latestShoppingList!.clearCheckedItems();
      await flushAsyncWork();
    });

    expect(latestShoppingList?.shoppingItems.map((item) => item.id)).toEqual(["b"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });

    expect(client.deleteShoppingItems).toHaveBeenCalledTimes(1);
    const deleteRequest = client.deleteShoppingItems.mock.calls[0]?.[0] as
      | { items: Array<{ id: string }> }
      | undefined;
    expect(deleteRequest?.items.map((item) => item.id)).toEqual(["a"]);
  });
});
