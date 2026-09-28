import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  addParsedShoppingItems,
  addShoppingItems,
  applyRemoteShoppingItems,
  deleteShoppingItems,
  getShoppingItems,
  getShoppingListSnapshot,
  loadShoppingList,
  putShoppingItems,
  resetShoppingListStoreForTests,
  setShoppingItemChecked,
  updateShoppingItemFromLine
} from "./shopping-list-store";
import {
  getShoppingSyncState,
  getShoppingWriteOptions,
  refreshShoppingHousehold,
  requestShoppingSync,
  resetShoppingSyncForTests,
  setShoppingAccount,
  SHOPPING_HOUSEHOLD_CACHE_KEY,
  syncShoppingNow,
  useShoppingSync
} from "./shopping-sync";

import type { ShoppingMode } from "./shopping-sync";
import type {
  DeleteShoppingItemsRequest,
  UpsertShoppingItemsRequest
} from "@linkdish/api-contracts";
import type { ShoppingItem } from "@linkdish/recipe-domain";

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
    JSON.stringify({
      checkedAt: Date.now() - ageMs,
      household,
      ...(household ? { householdId: "h1" } : {}),
      userId: "u1"
    })
  );
};

/* What the API answers an account that isn't in a household. */
const noHouseholdError = () =>
  new ExtractorApiError(
    "Extractor API request failed.",
    404,
    { message: "This account does not belong to an active household." },
    { kind: "http", serverMessage: "This account does not belong to an active household." }
  );

/* What the API answers when a batch holds an item stored in another household. */
const otherHouseholdItemError = () =>
  new ExtractorApiError(
    "Extractor API request failed.",
    403,
    { message: "This shopping item belongs to another household." },
    { kind: "http", serverMessage: "This shopping item belongs to another household." }
  );

const householdItem = (
  id: string,
  text: string,
  extra: Partial<ShoppingItem> = {}
): ShoppingItem => ({
  addedBy: "someone",
  checked: false,
  id,
  text,
  updatedAt: "2026-07-04T10:00:00.000Z",
  ...extra
});

/**
 * The household shopping API as the server implements it: item ids are global, each record
 * belongs to one household, and a batch touching another household's item is refused whole.
 * `use(null)`: the signed-in account isn't in a household.
 */
const createHouseholdServer = () => {
  const records = new Map<string, { householdId: string; item: ShoppingItem }>();
  const pushedIds: string[] = [];
  let householdId: string | null = "h1";
  const list = () =>
    [...records.values()]
      .filter((record) => record.householdId === householdId)
      .map((record) => record.item);
  const touchesOtherHousehold = (ids: readonly string[]) =>
    ids.some((id) => {
      const record = records.get(id);
      return record !== undefined && record.householdId !== householdId;
    });

  apiMocks.getHousehold.mockImplementation(() =>
    Promise.resolve({ household: householdId ? { id: householdId } : null })
  );
  apiMocks.getShoppingList.mockImplementation(() =>
    householdId ? Promise.resolve({ items: list() }) : Promise.reject(noHouseholdError())
  );
  apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
    const current = householdId;

    if (!current) {
      return Promise.reject(noHouseholdError());
    }

    pushedIds.push(...input.items.map((item) => item.id));

    if (touchesOtherHousehold(input.items.map((item) => item.id))) {
      return Promise.reject(otherHouseholdItemError());
    }

    for (const item of input.items) {
      records.set(item.id, { householdId: current, item });
    }

    return Promise.resolve({ ignored: [], items: list() });
  });
  apiMocks.deleteShoppingItems.mockImplementation((input: DeleteShoppingItemsRequest) => {
    if (!householdId) {
      return Promise.reject(noHouseholdError());
    }

    if (touchesOtherHousehold(input.items.map((item) => item.id))) {
      return Promise.reject(otherHouseholdItemError());
    }

    input.items.forEach((item) => records.delete(item.id));
    return Promise.resolve({
      deletedItemIds: input.items.map((item) => item.id),
      ignored: [],
      status: "deleted"
    });
  });

  return {
    pushedIds,
    records,
    seed(inHousehold: string, item: ShoppingItem) {
      records.set(item.id, { householdId: inHousehold, item });
    },
    use(nextHouseholdId: string | null) {
      householdId = nextHouseholdId;
    }
  };
};

const signIn = async (userId: string, mode: ShoppingMode = "household") => {
  setShoppingAccount({ isAuthenticated: true, loading: false, userId });
  await waitFor(() =>
    expect(getShoppingSyncState()).toMatchObject({ mode, modeResolved: true, userId })
  );
};

/** What another tab wrote after checking this account's household. */
const cacheFromOtherTab = (householdId: string | null, userId = "u1") => {
  window.localStorage.setItem(
    SHOPPING_HOUSEHOLD_CACHE_KEY,
    JSON.stringify({
      checkedAt: Date.now(),
      household: householdId !== null,
      ...(householdId ? { householdId } : {}),
      userId
    })
  );
};

const householdRecords = (server: ReturnType<typeof createHouseholdServer>, householdId: string) =>
  [...server.records.values()]
    .filter((record) => record.householdId === householdId)
    .map((record) => [record.item.text, record.item.qty]);

const signOut = () => {
  setShoppingAccount({ isAuthenticated: false, loading: false });
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
    window.sessionStorage.clear();
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
    expect(getShoppingWriteOptions()).toEqual({ canSync: true, householdId: "h1", userId: "u1" });
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

  it("keeps another household's unsent edit for it while a different account syncs", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("oat-milk", "oat milk"));
    server.seed("h2", householdItem("bread", "bread"));

    // u1 syncs household h1's list, signs out, then the item is edited on this device.
    await signIn("u1");
    await syncShoppingNow();
    signOut();
    await updateShoppingItemFromLine("oat-milk", "2 cups oat milk", getShoppingWriteOptions());

    // u2 signs into household h2 on the same device.
    server.use("h2");
    await signIn("u2");
    await loadShoppingList();
    await syncShoppingNow();

    expect(server.pushedIds).not.toContain("oat-milk");
    expect(server.records.get("oat-milk")).toMatchObject({
      householdId: "h1",
      item: { text: "oat milk" }
    });
    expect(getShoppingSyncState()).toMatchObject({ error: null, phase: "synced" });
    // u2 sees h2's list; u1's edit waits on this device, out of it.
    expect((await getShoppingItems()).map((item) => [item.text, item.sync.status])).toEqual([
      ["bread", "synced"]
    ]);
    await waitFor(() =>
      expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["bread"])
    );

    // u1 comes back: the edit reaches h1, once.
    signOut();
    server.use("h1");
    await signIn("u1");
    await syncShoppingNow();

    expect(server.records.get("oat-milk")).toMatchObject({
      householdId: "h1",
      item: { qty: 2, text: "oat milk", unit: "cup" }
    });
    expect((await getShoppingItems()).map((item) => [item.id, item.qty, item.sync])).toEqual([
      ["oat-milk", 2, expect.objectContaining({ householdId: "h1", status: "synced" })]
    ]);
  });

  it("keeps another household's unsent deletion for it while a different account syncs", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("eggs", "eggs"));
    server.seed("h1", householdItem("jam", "jam"));

    // u1 removes eggs in the store, offline: the deletion can't be sent yet.
    await signIn("u1");
    await syncShoppingNow();
    apiMocks.deleteShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await deleteShoppingItems(["eggs"], getShoppingWriteOptions());
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");
    signOut();

    server.use("h2");
    await signIn("u2");
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("synced");
    expect(await getShoppingItems()).toEqual([]);
    signOut();

    server.use("h1");
    await signIn("u1");
    await syncShoppingNow();

    expect(server.records.has("eggs")).toBe(false);
    expect((await getShoppingItems()).map((item) => item.text)).toEqual(["jam"]);
  });

  it("adds the next account's recipe to its own household, not to the last one's items", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { qty: 1, unit: "cup" }));
    server.seed("h1", householdItem("eggs-h1", "eggs", { checked: true, qty: 6 }));

    await signIn("u1");
    await syncShoppingNow();
    signOut();

    // u2 adds a recipe away from the shopping page, so h1's items are still on this device.
    server.use("h2");
    await signIn("u2");
    await addShoppingItems(
      [
        { recipeId: "r1", recipeTitle: "Pancakes", text: "2 cups milk" },
        { recipeId: "r1", recipeTitle: "Pancakes", text: "2 eggs" }
      ],
      getShoppingWriteOptions()
    );
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(
      [...server.records.values()]
        .filter((record) => record.householdId === "h2")
        .map((record) => [record.item.text, record.item.qty, record.item.checked])
    ).toEqual([
      ["milk", 2, false],
      ["eggs", 2, false]
    ]);
    expect(server.records.get("milk-h1")?.item).toMatchObject({ qty: 1 });
    expect(server.records.get("eggs-h1")?.item).toMatchObject({ checked: true, qty: 6 });
    expect((await getShoppingItems()).map((item) => [item.text, item.sync])).toEqual([
      ["milk", expect.objectContaining({ householdId: "h2", status: "synced" })],
      ["eggs", expect.objectContaining({ householdId: "h2", status: "synced" })]
    ]);
  });

  it("does not recreate a deleted item in the next account's household", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("eggs", "eggs"));

    await signIn("u1");
    await syncShoppingNow();
    signOut();
    await updateShoppingItemFromLine("eggs", "12 eggs", getShoppingWriteOptions());
    // Meanwhile someone in h1 removed it, so the server no longer has the record.
    server.records.delete("eggs");

    server.use("h2");
    await signIn("u2");
    await syncShoppingNow();

    expect(server.pushedIds).not.toContain("eggs");
    expect([...server.records.values()]).toEqual([]);
    expect(getShoppingSyncState().phase).toBe("synced");
    expect(await getShoppingItems()).toEqual([]);
  });

  it("keeps items added in one household out of the next one even before they were sent", async () => {
    const server = createHouseholdServer();

    await signIn("u1");
    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await addShoppingItems([{ text: "limes" }], getShoppingWriteOptions());
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");
    signOut();

    server.use("h2");
    await signIn("u2");
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.records.size).toBe(0);
    expect(await getShoppingItems()).toEqual([]);

    // Back in h1, they go there.
    signOut();
    server.use("h1");
    await signIn("u1");
    await syncShoppingNow();

    expect(
      [...server.records.values()].map((record) => [record.householdId, record.item.text])
    ).toEqual([["h1", "limes"]]);
  });

  it("leaves an item another account never sent, from before households were recorded, for it", async () => {
    const server = createHouseholdServer();
    server.seed("h2", householdItem("bread", "bread", { addedBy: "u7" }));
    // Written before changes recorded their household: u1 added limes but never sent them, and
    // h2's bread was checked off offline.
    await putShoppingItems([
      {
        addedBy: "u1",
        checked: false,
        checkedBy: null,
        createdAt: "2026-07-04T09:00:00.000Z",
        id: "limes",
        sync: { status: "dirty" },
        text: "limes",
        updatedAt: "2026-07-04T09:00:00.000Z"
      },
      {
        addedBy: "u7",
        checked: true,
        checkedBy: "u2",
        createdAt: "2026-07-04T10:00:00.000Z",
        id: "bread",
        sync: { status: "dirty" },
        text: "bread",
        updatedAt: "2026-07-04T11:00:00.000Z"
      }
    ]);

    server.use("h2");
    await signIn("u2");
    await syncShoppingNow();

    // u1's limes never reach u2's household...
    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.pushedIds).not.toContain("limes");
    expect(householdRecords(server, "h2")).toEqual([["bread", undefined]]);
    // ...but the check-off of h2's own bread does, once h2's list shows it is h2's.
    await syncShoppingNow();
    expect(server.records.get("bread")).toMatchObject({
      householdId: "h2",
      item: { checked: true }
    });

    // u1 comes back: the limes go to u1's household.
    signOut();
    server.use("h1");
    await signIn("u1");
    await syncShoppingNow();

    expect(server.pushedIds.filter((id) => id === "limes")).toEqual(["limes"]);
    expect(server.records.get("limes")).toMatchObject({
      householdId: "h1",
      item: { text: "limes" }
    });
  });

  it("stops a sync when another account signs in while it runs", async () => {
    const server = createHouseholdServer();
    server.seed("h2", householdItem("bread", "bread"));

    await signIn("u1");
    await addShoppingItems([{ text: "limes" }], getShoppingWriteOptions());
    // The push goes out as u1; u2 signs in before it answers.
    const answered = deferred<undefined>();
    const upsert = apiMocks.upsertShoppingItems.getMockImplementation();
    apiMocks.upsertShoppingItems.mockImplementationOnce(
      async (input: UpsertShoppingItemsRequest) => {
        const result: unknown = await upsert?.(input);
        await answered.promise;
        return result;
      }
    );
    const syncing = syncShoppingNow();
    await waitFor(() => expect(apiMocks.upsertShoppingItems).toHaveBeenCalledTimes(1));

    signOut();
    server.use("h2");
    await signIn("u2");
    answered.resolve(undefined);
    await syncing;

    // u1's sync stopped there; u2's list is h2's, pulled as h2's.
    await waitFor(() => expect(getShoppingSyncState().phase).toBe("synced"));
    expect(apiMocks.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(
      [...server.records.values()].map((record) => [record.householdId, record.item.text])
    ).toEqual([
      ["h2", "bread"],
      ["h1", "limes"]
    ]);
    const [bread] = await getShoppingItems();
    expect(bread).toMatchObject({ sync: { householdId: "h2", status: "synced" }, text: "bread" });

    // So u2's edits to h2's items go to h2.
    await updateShoppingItemFromLine(bread?.id ?? "", "2 loaves bread", getShoppingWriteOptions());
    await syncShoppingNow();
    expect(server.records.get("bread")).toMatchObject({ householdId: "h2", item: { qty: 2 } });
  });

  it("sends changes made under an out-of-date household to the account's current one", async () => {
    const server = createHouseholdServer();
    server.seed("h2", householdItem("milk-h2", "milk", { qty: 1, unit: "cup" }));
    // This device checked u1's household (h1) a moment ago; u1 has since moved to h2.
    cacheHousehold(true);
    server.use("h2");
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    expect(getShoppingSyncState()).toMatchObject({ householdId: "h1", mode: "household" });

    await syncShoppingNow();
    await updateShoppingItemFromLine("milk-h2", "3 cups milk", getShoppingWriteOptions());
    await addShoppingItems([{ text: "limes" }], getShoppingWriteOptions());
    await refreshShoppingHousehold({ force: true });
    expect(getShoppingSyncState().householdId).toBe("h2");

    await syncShoppingNow();

    // The account's changes followed it to h2.
    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.records.get("milk-h2")).toMatchObject({ householdId: "h2", item: { qty: 3 } });
    expect(
      [...server.records.values()].map((record) => [record.householdId, record.item.text])
    ).toEqual([
      ["h2", "milk"],
      ["h2", "limes"]
    ]);
    expect((await getShoppingItems()).map((item) => [item.text, item.qty, item.sync])).toEqual([
      ["milk", 3, expect.objectContaining({ householdId: "h2", status: "synced" })],
      ["limes", undefined, expect.objectContaining({ householdId: "h2", status: "synced" })]
    ]);
  });

  it("still sends offline edits when another member of the same household signs in", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("oat-milk", "oat milk"));

    await signIn("u1");
    await syncShoppingNow();
    signOut();
    await updateShoppingItemFromLine("oat-milk", "2 cups oat milk", getShoppingWriteOptions());

    await signIn("u2");
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.records.get("oat-milk")).toMatchObject({
      householdId: "h1",
      item: { qty: 2, text: "oat milk", unit: "cup" }
    });
    expect((await getShoppingItems()).map((item) => [item.id, item.sync.status])).toEqual([
      ["oat-milk", "synced"]
    ]);
  });

  it("checks which household it is in before sending when the cache predates household ids", async () => {
    window.localStorage.setItem(
      SHOPPING_HOUSEHOLD_CACHE_KEY,
      JSON.stringify({ checkedAt: Date.now(), household: true, userId: "u1" })
    );
    const household = deferred<{ household: { id: string } }>();
    apiMocks.getHousehold.mockReturnValue(household.promise);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    await addShoppingItems([{ text: "bread" }], getShoppingWriteOptions());

    const syncing = syncShoppingNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiMocks.upsertShoppingItems).not.toHaveBeenCalled();

    household.resolve({ household: { id: "h1" } });
    await syncing;

    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(1);
    expect(apiMocks.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(getShoppingSyncState()).toMatchObject({ householdId: "h1", phase: "synced" });
    expect(
      JSON.parse(window.localStorage.getItem(SHOPPING_HOUSEHOLD_CACHE_KEY) ?? "{}")
    ).toMatchObject({ household: true, householdId: "h1", userId: "u1" });
  });

  it("sends nothing while it can't tell which household it is in", async () => {
    window.localStorage.setItem(
      SHOPPING_HOUSEHOLD_CACHE_KEY,
      JSON.stringify({ checkedAt: Date.now(), household: true, userId: "u1" })
    );
    apiMocks.getHousehold.mockRejectedValue(new TypeError("Failed to fetch"));
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    await addShoppingItems([{ text: "bread" }], getShoppingWriteOptions());

    await syncShoppingNow();

    expect(getShoppingSyncState()).toMatchObject({ householdId: null, phase: "offline" });
    expect(apiMocks.upsertShoppingItems).not.toHaveBeenCalled();
    expect(apiMocks.getShoppingList).not.toHaveBeenCalled();
    expect((await getShoppingItems())[0]?.sync.status).toBe("dirty");
  });

  it("sends an account's unsent changes to its next household after it left one", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("limes", "limes", { addedBy: "u1" }));
    server.seed("h1", householdItem("bread", "bread", { addedBy: "u9" }));

    await signIn("u1");
    await syncShoppingNow();

    // u1 leaves h1 on another device (the server drops what u1 added there). Before this
    // device notices, u1 asks for 3 limes here.
    server.use(null);
    server.records.delete("limes");
    await updateShoppingItemFromLine("limes", "3 limes", getShoppingWriteOptions());

    await refreshShoppingHousehold({ force: true });
    expect(getShoppingSyncState()).toMatchObject({ householdId: null, mode: "local" });
    // h1's list isn't this account's any more.
    expect(await getShoppingItems()).toEqual([]);
    expect(await setShoppingItemChecked("bread", true, getShoppingWriteOptions())).toBeUndefined();

    // u1 starts a household of their own: the change goes there.
    server.use("h2");
    await refreshShoppingHousehold({ force: true });
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.records.get("limes")).toMatchObject({ householdId: "h2", item: { qty: 3 } });
    expect(server.records.get("bread")).toMatchObject({
      householdId: "h1",
      item: { checked: false }
    });
    expect((await getShoppingItems()).map((item) => [item.text, item.qty, item.sync])).toEqual([
      ["limes", 3, expect.objectContaining({ householdId: "h2", status: "synced" })]
    ]);
  });

  it("sends an account's unsent changes to its new household after another account used the device", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("limes", "limes", { addedBy: "u1" }));

    await signIn("u1");
    await syncShoppingNow();
    // Offline in the shop: 3 limes, not sent yet.
    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await updateShoppingItemFromLine("limes", "3 limes", getShoppingWriteOptions());
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");
    signOut();

    // u2 (in h2) uses this device, so the household cache is u2's now.
    server.use("h2");
    await signIn("u2");
    await syncShoppingNow();
    signOut();
    expect(server.pushedIds).not.toContain("limes");

    // Meanwhile u1 moved to h3 (leaving h1 dropped u1's limes there).
    server.records.delete("limes");
    server.use("h3");
    await signIn("u1");
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(server.records.get("limes")).toMatchObject({ householdId: "h3", item: { qty: 3 } });
  });

  it("doesn't let an account without a household change the last account's items", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1", qty: 1, unit: "cup" }));

    await signIn("u1");
    await syncShoppingNow();
    signOut();
    // Signed out, this device shows everything on it.
    expect((await getShoppingItems()).map((item) => item.text)).toEqual(["milk"]);

    // u2, who isn't in a household, signs in on the same device and adds milk.
    server.use(null);
    await signIn("u2", "local");
    expect(await getShoppingItems()).toEqual([]);
    expect(
      await setShoppingItemChecked("milk-h1", true, getShoppingWriteOptions())
    ).toBeUndefined();
    await addShoppingItems([{ text: "2 cups milk" }], getShoppingWriteOptions());
    expect((await getShoppingItems()).map((item) => [item.text, item.qty])).toEqual([["milk", 2]]);

    // u2 starts a household of their own.
    server.use("h2");
    await refreshShoppingHousehold({ force: true });
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("synced");
    expect((await getShoppingItems()).map((item) => [item.text, item.qty])).toEqual([["milk", 2]]);

    // u1's household never gets u2's milk.
    signOut();
    server.use("h1");
    await signIn("u1");
    await syncShoppingNow();
    expect(server.records.get("milk-h1")?.item).toMatchObject({ checked: false, qty: 1 });
  });

  it("keeps the last account's items off the list while the next account's check is out", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1", qty: 1, unit: "cup" }));

    await signIn("u1");
    await syncShoppingNow();
    signOut();

    server.use("h2");
    const household = deferred<{ household: { id: string } }>();
    apiMocks.getHousehold.mockReturnValueOnce(household.promise);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u2" });
    await loadShoppingList({ force: true });
    await waitFor(() => expect(getShoppingListSnapshot().items).toEqual([]));

    // A recipe goes on the list before the check answers.
    await addShoppingItems(
      [{ recipeId: "r1", recipeTitle: "Pancakes", text: "2 cups milk" }],
      getShoppingWriteOptions()
    );
    household.resolve({ household: { id: "h2" } });
    await waitFor(() => expect(getShoppingSyncState().householdId).toBe("h2"));
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect((await getShoppingItems()).map((item) => [item.text, item.qty])).toEqual([["milk", 2]]);
    expect(server.records.get("milk-h1")?.item).toMatchObject({ qty: 1 });
  });

  it("shows each member's household list at once on a device they share", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1", qty: 1, unit: "cup" }));

    // u1 and u2, both in h1, take turns on one device.
    await signIn("u1");
    await syncShoppingNow();
    signOut();
    await signIn("u2");
    await syncShoppingNow();
    signOut();

    // u1 again, with this sign-in's household check still out.
    const household = deferred<{ household: { id: string } }>();
    apiMocks.getHousehold.mockReturnValueOnce(household.promise);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    expect(getShoppingSyncState()).toMatchObject({
      householdId: "h1",
      mode: "household",
      modeResolved: true
    });
    await loadShoppingList({ force: true });
    expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["milk"]);

    // Milk from the plan adds up with h1's milk, and it can be checked off.
    await addParsedShoppingItems(
      [{ qty: 2, text: "milk", unit: "cup" }],
      getShoppingWriteOptions()
    );
    expect(await setShoppingItemChecked("milk-h1", true, getShoppingWriteOptions())).toBeDefined();

    // Nothing is sent before this sign-in's check confirms the household.
    const syncing = syncShoppingNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.pushedIds).toEqual([]);

    household.resolve({ household: { id: "h1" } });
    await syncing;

    expect(getShoppingSyncState()).toMatchObject({ householdId: "h1", phase: "synced" });
    expect(server.records.get("milk-h1")?.item).toMatchObject({ checked: true, qty: 3 });
    expect((await getShoppingItems()).map((item) => [item.id, item.qty, item.sync.status])).toEqual(
      [["milk-h1", 3, "synced"]]
    );
  });

  it("sends nothing to an account's remembered household until this sign-in's check confirms it", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1" }));

    await signIn("u1");
    await syncShoppingNow();
    signOut();

    // u7, also in h1, adds limes offline and signs out.
    await signIn("u7");
    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await addShoppingItems([{ text: "limes" }], getShoppingWriteOptions());
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");
    signOut();

    // Meanwhile u1 moved to h2 on another device. Here, u1's last answer still says h1: the
    // list shows it, but nothing is sent until the check answers, and the limes stay h1's.
    server.use("h2");
    apiMocks.getHousehold
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    expect(getShoppingSyncState().householdId).toBe("h1");
    await loadShoppingList({ force: true });
    expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["milk", "limes"]);
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("offline");
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(1);
    expect(server.pushedIds).toEqual([]);

    await refreshShoppingHousehold({ force: true });
    await syncShoppingNow();

    expect(getShoppingSyncState()).toMatchObject({ householdId: "h2", phase: "synced" });
    expect(server.pushedIds).toEqual([]);
    expect(householdRecords(server, "h2")).toEqual([]);
  });

  it("remembers an account's household across sign-ins when storage can't be written", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1" }));
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const setSessionItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    try {
      await signIn("u1");
      await syncShoppingNow();
      signOut();

      // Offline when u1 signs in again: the list is still h1's, and can be checked off.
      apiMocks.getHousehold.mockRejectedValue(new TypeError("Failed to fetch"));
      setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
      expect(getShoppingSyncState()).toMatchObject({ householdId: "h1", mode: "household" });
      await loadShoppingList({ force: true });
      expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["milk"]);
      expect(
        await setShoppingItemChecked("milk-h1", true, getShoppingWriteOptions())
      ).toBeDefined();
    } finally {
      setItem.mockRestore();
      setSessionItem.mockRestore();
    }
  });

  it("remembers an account's household across a reload when only session storage can be written", async () => {
    const server = createHouseholdServer();
    server.seed("h1", householdItem("milk-h1", "milk", { addedBy: "u1" }));
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });

    try {
      await signIn("u1");
      await syncShoppingNow();

      // Reload, offline.
      resetShoppingSyncForTests();
      resetShoppingListStoreForTests();
      resetLinkDishWebDbForTests();
      apiMocks.getHousehold.mockRejectedValue(new TypeError("Failed to fetch"));
      setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });

      expect(getShoppingSyncState()).toMatchObject({ householdId: "h1", mode: "household" });
      await loadShoppingList();
      expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["milk"]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("follows a household another tab has just confirmed for this account", async () => {
    const server = createHouseholdServer();
    const milk = householdItem("milk-h2", "milk", { addedBy: "u7", qty: 1, unit: "cup" });
    server.seed("h2", milk);
    // This tab checked a moment ago: u1 is in h1.
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    expect(getShoppingSyncState().householdId).toBe("h1");

    // u1 has moved to h2. Another tab checked, wrote the shared cache and pulled h2's list.
    server.use("h2");
    cacheFromOtherTab("h2");
    await applyRemoteShoppingItems([milk], { householdId: "h2", prune: true });

    // This tab comes back into view: the cache is fresh, so it doesn't check itself...
    await refreshShoppingHousehold();
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
    // ...and shows h2's list, so milk from the plan adds up with h2's milk.
    expect(getShoppingSyncState().householdId).toBe("h2");
    await addParsedShoppingItems(
      [{ qty: 2, text: "milk", unit: "cup" }],
      getShoppingWriteOptions()
    );
    await syncShoppingNow();

    expect(householdRecords(server, "h2")).toEqual([["milk", 3]]);
    expect(
      (await getShoppingItems({ includeOtherHouseholds: true })).map((item) => [
        item.id,
        item.qty,
        item.sync.householdId
      ])
    ).toEqual([["milk-h2", 3, "h2"]]);
  });

  it("syncs with the household another tab confirmed, and follows it as soon as it's written", async () => {
    const server = createHouseholdServer();
    server.seed("h2", householdItem("bread", "bread", { addedBy: "u7" }));
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });

    // Another tab learned that u1 moved to h2; this tab syncs before hearing of it.
    server.use("h2");
    cacheFromOtherTab("h2");
    await syncShoppingNow();

    expect(getShoppingSyncState()).toMatchObject({ householdId: "h2", phase: "synced" });
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
    expect((await getShoppingItems()).map((item) => [item.text, item.sync.householdId])).toEqual([
      ["bread", "h2"]
    ]);

    // Another account's answer is not this account's.
    cacheFromOtherTab("h9", "u2");
    window.dispatchEvent(new StorageEvent("storage", { key: SHOPPING_HOUSEHOLD_CACHE_KEY }));
    expect(getShoppingSyncState().householdId).toBe("h2");

    // Another tab sees u1 leave: this tab follows as soon as the cache changes.
    cacheFromOtherTab(null);
    window.dispatchEvent(new StorageEvent("storage", { key: SHOPPING_HOUSEHOLD_CACHE_KEY }));
    expect(getShoppingSyncState()).toMatchObject({ householdId: null, mode: "local" });
    await waitFor(async () => expect(await getShoppingItems()).toEqual([]));
  });

  it("tells offline apart from other failures and keeps local changes", async () => {
    cacheHousehold(true);
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    await addShoppingItems([{ text: "bread" }], getShoppingWriteOptions());

    apiMocks.upsertShoppingItems.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await syncShoppingNow();
    expect(getShoppingSyncState().phase).toBe("offline");

    // How the API client reports a server it can't reach.
    apiMocks.upsertShoppingItems.mockRejectedValueOnce(
      new ExtractorApiError("Failed to fetch", 0, undefined, { kind: "network" })
    );
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
