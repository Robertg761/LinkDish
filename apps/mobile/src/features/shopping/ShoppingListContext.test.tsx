import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    addEventListener: () => ({ remove: () => undefined })
  }
}));

import { ShoppingListProvider, useShoppingList } from "./ShoppingListContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latestShoppingList: ReturnType<typeof useShoppingList> | null = null;

const Probe = () => {
  latestShoppingList = useShoppingList();
  return null;
};

const flushAsyncWork = async () => {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
};

const renderProvider = async () => {
  await act(async () => {
    create(
      <ShoppingListProvider>
        <Probe />
      </ShoppingListProvider>
    );
    await flushAsyncWork();
  });

  await act(async () => {
    await flushAsyncWork();
  });
};

describe("ShoppingListProvider storage recovery", () => {
  beforeEach(() => {
    latestShoppingList = null;
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
    apiMocks.createExtractorApiClient.mockReturnValue({
      deleteShoppingItems: vi.fn(),
      getHousehold: vi.fn().mockResolvedValue({ household: null }),
      getShoppingList: vi.fn().mockResolvedValue({ items: [] }),
      upsertShoppingItems: vi.fn()
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("does not overwrite a corrupt shopping list with an empty one", async () => {
    const corruptBlob = '[{"id":"item_1","text":"Milk"';
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === "linkdish.shoppingItems.v1" ? corruptBlob : null)
    );

    await renderProvider();

    expect(latestShoppingList?.hasLoadedShoppingItems).toBe(true);
    expect(latestShoppingList?.shoppingItems).toHaveLength(0);
    expect(
      asyncStorageMocks.setItem.mock.calls.some(([key]) => key === "linkdish.shoppingItems.v1")
    ).toBe(false);
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith(
      "linkdish.shoppingItems.corrupt.v1",
      corruptBlob
    );

    await act(async () => {
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "Milk" }]);
      await flushAsyncWork();
    });

    expect(
      asyncStorageMocks.setItem.mock.calls.some(([key]) => key === "linkdish.shoppingItems.v1")
    ).toBe(true);
  });

  it("persists a readable shopping list as usual", async () => {
    await renderProvider();

    await act(async () => {
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "Eggs" }]);
      await flushAsyncWork();
    });

    const writes = asyncStorageMocks.setItem.mock.calls
      .filter(([key]) => key === "linkdish.shoppingItems.v1")
      .map(([, value]) => String(value));

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1]).toContain("Eggs");
  });
});
