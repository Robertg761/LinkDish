import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  addShoppingItems,
  getShoppingItems,
  resetShoppingListStoreForTests
} from "./shopping-list-store";
import {
  getShoppingSyncState,
  getShoppingWriteOptions,
  requestShoppingSync,
  resetShoppingSyncForTests,
  setShoppingAccount,
  SHOPPING_HOUSEHOLD_CACHE_KEY,
  syncShoppingNow,
  useShoppingSync
} from "./shopping-sync";

import type { UpsertShoppingItemsRequest } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  deleteShoppingItems: vi.fn(),
  getHousehold: vi.fn(),
  getShoppingList: vi.fn(),
  upsertShoppingItems: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  auth: {
    credentialsKey: null as string | null,
    isAuthenticated: true,
    loading: false,
    user: { id: "u1" } as { id: string } | null
  }
}));

vi.mock("../../api/client", () => ({ apiClient: apiMocks }));
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => authMocks.auth }));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const cacheHousehold = (household: boolean, ageMs = 0) => {
  window.localStorage.setItem(
    SHOPPING_HOUSEHOLD_CACHE_KEY,
    JSON.stringify({ checkedAt: Date.now() - ageMs, household, userId: "u1" })
  );
};

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("shopping-sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    authMocks.auth = {
      credentialsKey: null,
      isAuthenticated: true,
      loading: false,
      user: { id: "u1" }
    };
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) =>
      Promise.resolve({ ignored: [], items: input.items })
    );
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    resetShoppingSyncForTests();
  });

  it("uses the cached household mode at once and refreshes it in the background", async () => {
    cacheHousehold(true, 10 * 60_000);
    const household = deferred<{ household: null }>();
    apiMocks.getHousehold.mockReturnValue(household.promise);

    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });

    expect(getShoppingSyncState()).toMatchObject({ mode: "household", modeResolved: true });
    expect(getShoppingWriteOptions()).toEqual({ canSync: true, userId: "u1" });
    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(1);

    household.resolve({ household: null });
    await waitFor(() => expect(getShoppingSyncState().mode).toBe("local"));
    expect(
      JSON.parse(window.localStorage.getItem(SHOPPING_HOUSEHOLD_CACHE_KEY) ?? "{}")
    ).toMatchObject({ household: false, userId: "u1" });
  });

  it("assumes the last account on this device while sign-in is still loading", () => {
    cacheHousehold(true);

    setShoppingAccount({ isAuthenticated: false, loading: true });

    expect(getShoppingSyncState()).toMatchObject({ mode: "household", userId: "u1" });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
  });

  it("waits for a signed-in session's credentials before checking or syncing", async () => {
    cacheHousehold(true, 10 * 60_000);
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "h1" } });

    // Auth has settled, but a cached Clerk user's session can't be read yet.
    setShoppingAccount({
      credentialsKey: null,
      isAuthenticated: true,
      loading: false,
      userId: "u1"
    });
    await syncShoppingNow();

    expect(getShoppingSyncState()).toMatchObject({ mode: "household", userId: "u1" });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
    expect(apiMocks.getShoppingList).not.toHaveBeenCalled();

    // A caller that doesn't track credentials doesn't open the gate early.
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();

    setShoppingAccount({
      credentialsKey: "clerk:u1",
      isAuthenticated: true,
      loading: false,
      userId: "u1"
    });

    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(1);
    // The sync asked for while waiting runs now.
    await waitFor(() => expect(getShoppingSyncState().phase).toBe("synced"));
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(1);
  });

  it("checks and syncs again when Clerk signs in after the wait ran out", async () => {
    cacheHousehold(true);
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "h1" } });
    // The wait for Clerk ran out, so the first sync went out with the legacy session: refused.
    apiMocks.getShoppingList.mockRejectedValueOnce(new Error("Unauthorized"));
    authMocks.auth = {
      credentialsKey: "session:u1",
      isAuthenticated: true,
      loading: false,
      user: { id: "u1" }
    };
    const { rerender } = renderHook(() => useShoppingSync());

    await waitFor(() => expect(getShoppingSyncState().phase).toBe("error"));
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();

    authMocks.auth = { ...authMocks.auth, credentialsKey: "clerk:u1" };
    act(() => rerender());

    await waitFor(() => expect(getShoppingSyncState().phase).toBe("synced"));
    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(1);
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(2);
  });

  it("keeps signed-out lists on this device without any network", async () => {
    setShoppingAccount({ isAuthenticated: false, loading: false });
    requestShoppingSync({ delayMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(getShoppingSyncState()).toMatchObject({ mode: "local", modeResolved: true });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
    expect(apiMocks.getShoppingList).not.toHaveBeenCalled();
  });

  it("coalesces a burst of changes into one push and pull", async () => {
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    await addShoppingItems([{ text: "2 lemons" }, { text: "milk" }], getShoppingWriteOptions());

    requestShoppingSync({ delayMs: 30 });
    requestShoppingSync({ delayMs: 30 });
    requestShoppingSync({ delayMs: 30 });

    await waitFor(() => expect(getShoppingSyncState().phase).toBe("synced"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(apiMocks.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(apiMocks.upsertShoppingItems.mock.calls[0]?.[0]).toMatchObject({
      items: [
        expect.objectContaining({ text: "lemons" }),
        expect.objectContaining({ text: "milk" })
      ]
    });
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(1);
    expect(getShoppingSyncState().lastSyncedAt).not.toBeNull();
  });

  it("runs once more when a sync is requested while one is running", async () => {
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    const firstPull = deferred<{ items: [] }>();
    apiMocks.getShoppingList.mockReturnValueOnce(firstPull.promise);

    const first = syncShoppingNow();
    void syncShoppingNow();
    void syncShoppingNow();
    firstPull.resolve({ items: [] });
    await first;

    await waitFor(() => expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(2);
  });

  it("tells offline apart from other failures and keeps local changes", async () => {
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    await addShoppingItems([{ text: "bread" }], getShoppingWriteOptions());

    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");

    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new Error("boom"));
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("error");

    const [bread] = await getShoppingItems();
    expect(bread?.sync.status).toBe("dirty");

    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("synced");
  });
});
