import { ExtractorApiError } from "@linkdish/api-client";
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

vi.mock("@linkdish/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
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
import { setAsideShoppingItemId } from "./store";

import type { MobileShoppingItem } from "./store";
import type * as ApiClientModule from "@linkdish/api-client";
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

const OTHER_HOUSEHOLD_MESSAGE = "This shopping item belongs to another household.";

/**
 * The household list API as the server runs it: every item lives in one household, and a batch
 * holding another household's item is refused whole (403) without writing anything.
 */
const createHouseholdServer = (records: Array<{ householdId: string; item: ShoppingItem }>) => {
  const stored = new Map(records.map((record) => [record.item.id, record]));
  /** Whose household requests reach (the signed-in account's), and whether they reach it at all. */
  const session = { householdId: "household_1", online: true };
  /** The household each upsert or delete request reached, with the ids it carried. */
  const requests: Array<{ householdId: string; ids: string[] }> = [];
  const unreachable = () => Promise.reject(new TypeError("Network request failed"));
  const listItems = () =>
    [...stored.values()]
      .filter((record) => record.householdId === session.householdId)
      .map((record) => record.item);
  const holdsForeignItem = (ids: string[]) =>
    ids.some((id) => {
      const record = stored.get(id);
      return record !== undefined && record.householdId !== session.householdId;
    });
  const refuse = () =>
    Promise.reject(
      new ExtractorApiError("Extractor API request failed.", 403, {
        message: OTHER_HOUSEHOLD_MESSAGE
      })
    );
  const client = {
    deleteShoppingItems: vi.fn(({ items }: { items: Array<{ id: string }> }) => {
      if (!session.online) {
        return unreachable();
      }

      requests.push({ householdId: session.householdId, ids: items.map((item) => item.id) });

      if (holdsForeignItem(items.map((item) => item.id))) {
        return refuse();
      }

      items.forEach((item) => stored.delete(item.id));
      return Promise.resolve({
        deletedItemIds: items.map((item) => item.id),
        ignored: [],
        status: "deleted"
      });
    }),
    getHousehold: vi.fn(() =>
      session.online ? Promise.resolve({ household: { id: session.householdId } }) : unreachable()
    ),
    getShoppingList: vi.fn(() =>
      session.online ? Promise.resolve({ items: listItems() }) : unreachable()
    ),
    upsertShoppingItems: vi.fn(({ items }: { items: ShoppingItem[] }) => {
      if (!session.online) {
        return unreachable();
      }

      requests.push({ householdId: session.householdId, ids: items.map((item) => item.id) });

      if (holdsForeignItem(items.map((item) => item.id))) {
        return refuse();
      }

      items.forEach((item) =>
        stored.set(item.id, { householdId: session.householdId, item: { ...item } })
      );
      return Promise.resolve({ ignored: [], items: listItems() });
    })
  };

  return { client, requests, session, stored };
};

type HouseholdServer = ReturnType<typeof createHouseholdServer>;

const switchAccount = async (
  renderer: ReturnType<typeof create>,
  user: { email: string; id: string } | null
) => {
  accountState.isSignedIn = user !== null;
  accountState.user = user;

  await act(async () => {
    renderer.update(
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

/** Every id sent to the household list in upserts and deletes, in order. */
const sentIds = (server: HouseholdServer) => [
  ...server.client.upsertShoppingItems.mock.calls.flatMap(([input]) =>
    input.items.map((item) => item.id)
  ),
  ...server.client.deleteShoppingItems.mock.calls.flatMap(([input]) =>
    input.items.map((item) => item.id)
  )
];

const listSummary = () =>
  (latestShoppingList?.shoppingItems ?? [])
    .map((item) => [item.text, item.checked, item.sync.status] as const)
    .sort(([a], [b]) => a.localeCompare(b));

/** Everything this device keeps, as last written (other households' records included). */
const storedItems = async (): Promise<MobileShoppingItem[]> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SHOPPING_PERSIST_DEBOUNCE_MS);
  });
  const writes = shoppingWrites();
  return JSON.parse(writes[writes.length - 1] ?? "[]") as MobileShoppingItem[];
};

/** Every item id that reached `householdId` in an upsert or delete request. */
const idsSentTo = (server: HouseholdServer, householdId: string) =>
  server.requests
    .filter((request) => request.householdId === householdId)
    .flatMap((request) => request.ids);

/** Items a household holds on the server, as [text, qty, checked], in the order stored. */
const householdItems = (server: HouseholdServer, householdId: string) =>
  [...server.stored.values()]
    .filter((record) => record.householdId === householdId)
    .map((record) => [record.item.text, record.item.qty ?? null, record.item.checked] as const);

describe("ShoppingListProvider across accounts on one device", () => {
  const firstCook = { email: "first@example.com", id: "user_1" };
  const nextCook = { email: "next@example.com", id: "user_2" };
  const updatedAt = "2026-07-04T12:00:00.000Z";
  const milk: ShoppingItem = {
    addedBy: "user_1",
    checked: false,
    id: "milk",
    text: "milk",
    updatedAt
  };
  const bread: ShoppingItem = {
    addedBy: "user_2",
    checked: false,
    id: "bread",
    text: "bread",
    updatedAt
  };

  beforeEach(() => {
    vi.useFakeTimers();
    latestShoppingList = null;
    appStateMocks.listeners = [];
    accountState.getAuthHeaders.mockReset();
    accountState.getAuthHeaders.mockResolvedValue({});
    accountState.isSignedIn = true;
    accountState.user = firstCook;
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue(null);
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    apiMocks.createExtractorApiClient.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Signed in to household_1, the first cook makes `edit` offline, then signs out. */
  const leaveUnsentChange = async (server: HouseholdServer, edit: () => void) => {
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);
    const renderer = await renderProvider();

    await makeOfflineChange(server, edit);

    await switchAccount(renderer, null);
    return renderer;
  };

  /** `edit` is made while the household list can't be reached, so it stays unsent. */
  const makeOfflineChange = async (server: HouseholdServer, edit: () => void) => {
    server.session.online = false;
    await act(async () => {
      edit();
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });
    expect(latestShoppingList?.shoppingError).toBe("Network request failed");
    server.session.online = true;
  };

  /** Signs whoever is signed in out, then `user` in to `householdId`. */
  const signInTo = async (
    renderer: ReturnType<typeof create>,
    server: HouseholdServer,
    user: { email: string; id: string },
    householdId: string
  ) => {
    await switchAccount(renderer, null);
    server.session.householdId = householdId;
    await switchAccount(renderer, user);
  };

  it("never sends the last account's unsent change to the next account's household", async () => {
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_2", item: bread }
    ]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.setItemChecked("milk", true);
    });
    const sentBefore = sentIds(server).length;

    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);

    // The check-off waits on this device for household_1, out of household_2's list, and
    // doesn't block it.
    expect(sentIds(server).slice(sentBefore)).toEqual([]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["bread", false, "synced"]]);
    expect(server.stored.get("milk")).toEqual({ householdId: "household_1", item: milk });
    expect((await storedItems()).find((item) => item.id === "milk")).toMatchObject({
      checked: true,
      sync: { householdId: "household_1", status: "sync_failed" }
    });

    // Nothing is sent that the household list would refuse.
    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });
    expect(sentIds(server).slice(sentBefore)).toEqual([]);
    expect(latestShoppingList?.shoppingError).toBeNull();
  });

  it("does not recreate the last account's items in the next account's household", async () => {
    const server = createHouseholdServer([{ householdId: "household_1", item: milk }]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.setItemChecked("milk", true);
      latestShoppingList!.addItems([{ text: "2 eggs" }]);
    });

    // Another member of the first household deletes the milk meanwhile.
    server.stored.delete("milk");
    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);

    expect([...server.stored.values()]).toEqual([]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([]);
    expect(
      (await storedItems()).map((item) => [item.text, item.sync.householdId, item.sync.status])
    ).toEqual(
      expect.arrayContaining([
        ["milk", "household_1", "sync_failed"],
        ["eggs", "household_1", "sync_failed"]
      ])
    );
  });

  it("sends the last account's unsent edit to its household, once, when it signs back in", async () => {
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_2", item: bread }
    ]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.setItemChecked("milk", true);
    });

    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["bread", false, "synced"]]);

    // The first cook comes back.
    const sentBefore = sentIds(server).length;
    await signInTo(renderer, server, firstCook, "household_1");

    expect(sentIds(server).slice(sentBefore)).toEqual(["milk"]);
    expect(server.stored.get("milk")).toMatchObject({
      householdId: "household_1",
      item: { checked: true, checkedBy: "user_1" }
    });
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["milk", true, "synced"]]);
    // One milk on this device: the edit went back as itself, not as a copy.
    expect((await storedItems()).filter((item) => item.text === "milk")).toHaveLength(1);

    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });
    expect(sentIds(server).slice(sentBefore)).toEqual(["milk"]);
  });

  it("keeps the last account's unsent deletion for its household", async () => {
    const eggs: ShoppingItem = { ...milk, id: "eggs", text: "eggs" };
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_1", item: eggs },
      { householdId: "household_2", item: bread }
    ]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.deleteItem("eggs");
    });
    const sentBefore = sentIds(server).length;

    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);
    expect(sentIds(server).slice(sentBefore)).toEqual([]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["bread", false, "synced"]]);

    await signInTo(renderer, server, firstCook, "household_1");

    expect(server.stored.has("eggs")).toBe(false);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["milk", false, "synced"]]);
    expect((await storedItems()).map((item) => item.id).sort()).toEqual(["bread", "milk"]);
  });

  it("keeps the last household's items out of the next account's list, merges and edits", async () => {
    const cupOfMilk: ShoppingItem = { ...milk, qty: 1, unit: "cup" };
    const server = createHouseholdServer([
      { householdId: "household_1", item: cupOfMilk },
      { householdId: "household_2", item: bread }
    ]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.addItems([{ text: "limes" }]);
    });
    const limesId = (await storedItems()).find((item) => item.text === "limes")?.id ?? "";
    const sentBefore = sentIds(server).length;

    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);
    expect(listSummary()).toEqual([["bread", false, "synced"]]);

    // The next cook adds milk from a recipe and reaches for household_1's items by id.
    await act(async () => {
      latestShoppingList!.addItems([{ recipeId: "recipe_1", text: "2 cups milk" }]);
      latestShoppingList!.setItemChecked("milk", true);
      latestShoppingList!.deleteItem(limesId);
      latestShoppingList!.setItemChecked("bread", true);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });

    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(householdItems(server, "household_2")).toEqual([
      ["bread", null, true],
      ["milk", 2, false]
    ]);
    expect(server.stored.get("milk")).toEqual({ householdId: "household_1", item: cupOfMilk });
    expect(sentIds(server).slice(sentBefore)).not.toContain("milk");
    expect(sentIds(server).slice(sentBefore)).not.toContain(limesId);
    expect(listSummary()).toEqual([
      ["bread", true, "synced"],
      ["milk", false, "synced"]
    ]);
    expect(latestShoppingList?.shoppingItems.map((item) => item.id)).not.toContain("milk");

    // Household_1's records on this device are as the first cook left them.
    const stored = await storedItems();
    expect(stored.find((item) => item.id === "milk")).toMatchObject({
      checked: false,
      qty: 1,
      sync: { householdId: "household_1", status: "synced" }
    });
    expect(stored.find((item) => item.id === limesId)).toMatchObject({
      sync: { householdId: "household_1", status: "sync_failed" },
      text: "limes"
    });
    expect(stored.find((item) => item.id === limesId)).not.toHaveProperty("isDeleted");

    // While its household can't be checked (offline), the list is still household_2's.
    server.session.online = false;
    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });
    server.session.online = true;
    expect(latestShoppingList?.shoppingError).toBe("Network request failed");
    expect(latestShoppingList?.canSyncShoppingList).toBe(true);
    expect(listSummary()).toEqual([
      ["bread", true, "synced"],
      ["milk", false, "synced"]
    ]);
  });

  it("still sends offline edits when another member of the same household signs in", async () => {
    const server = createHouseholdServer([{ householdId: "household_1", item: milk }]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.setItemChecked("milk", true);
    });

    await switchAccount(renderer, nextCook);

    expect(server.stored.get("milk")).toMatchObject({
      householdId: "household_1",
      item: { checked: true, checkedBy: "user_1", id: "milk" }
    });
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["milk", true, "synced"]]);
  });

  it("still sends offline edits to their household after another household used the device", async () => {
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_2", item: bread }
    ]);
    const renderer = await leaveUnsentChange(server, () => {
      latestShoppingList!.setItemChecked("milk", true);
    });

    server.session.householdId = "household_2";
    await switchAccount(renderer, nextCook);
    expect(server.stored.get("milk")?.item.checked).toBe(false);

    // Another member of household_1 signs in.
    await signInTo(renderer, server, { email: "partner@example.com", id: "user_3" }, "household_1");

    expect(server.stored.get("milk")).toMatchObject({
      householdId: "household_1",
      item: { checked: true, checkedBy: "user_1" }
    });
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["milk", true, "synced"]]);
  });

  it("takes an account's unsent changes along when it moves to another household", async () => {
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_3", item: bread }
    ]);
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);
    await renderProvider();
    await makeOfflineChange(server, () => {
      latestShoppingList!.addItems([{ text: "limes" }]);
    });

    // The first cook leaves household_1 for household_3.
    server.session.householdId = "household_3";
    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });

    expect(householdItems(server, "household_3")).toEqual([
      ["bread", null, false],
      ["limes", null, false]
    ]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([
      ["bread", false, "synced"],
      ["limes", false, "synced"]
    ]);
  });

  it("does not use a household answer that arrives after its account signed out", async () => {
    const storedItem = (id: string, sync: MobileShoppingItem["sync"]) => ({
      addedBy: "user_1",
      checked: false,
      createdAt: updatedAt,
      id,
      sync,
      text: id,
      updatedAt
    });
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === "linkdish.shoppingItems.v1"
          ? JSON.stringify([
              storedItem("limes", { householdId: "household_1", status: "sync_failed" }),
              // Stored before items recorded their household.
              storedItem("jam", { status: "dirty" })
            ])
          : null
      )
    );
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_2", item: bread }
    ]);
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);
    // The first cook's household check is slow to answer; meanwhile they sign out and the next
    // cook signs in to household_2.
    const householdAnswer = createDeferred<{ household: { id: string } }>();
    server.client.getHousehold.mockReturnValueOnce(householdAnswer.promise);
    const renderer = await renderProvider();
    await signInTo(renderer, server, nextCook, "household_2");

    await act(async () => {
      householdAnswer.resolve({ household: { id: "household_1" } });
      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The first cook's pass stopped there: its limes wait for household_1, and the change that
    // names no household went to the household of the account signed in now.
    expect(idsSentTo(server, "household_2")).toEqual(["jam"]);
    expect(householdItems(server, "household_2")).toEqual([
      ["bread", null, false],
      ["jam", null, false]
    ]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([
      ["bread", false, "synced"],
      ["jam", false, "synced"]
    ]);
    expect((await storedItems()).find((item) => item.id === "limes")?.sync).toEqual({
      householdId: "household_1",
      status: "sync_failed"
    });

    // The limes still reach household_1 when the first cook is back.
    await signInTo(renderer, server, firstCook, "household_1");
    expect(householdItems(server, "household_1")).toEqual([
      ["milk", null, false],
      ["limes", null, false]
    ]);
    expect(idsSentTo(server, "household_2")).toEqual(["jam"]);
  });

  it("sends nothing more once its account signs out in the middle of a push", async () => {
    const eggs: ShoppingItem = { ...milk, id: "eggs", text: "eggs" };
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_1", item: eggs },
      { householdId: "household_2", item: bread }
    ]);
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);
    const renderer = await renderProvider();

    // The first cook checks off milk and removes eggs. The check-off reaches household_1, but
    // its answer is slow; by the time it arrives the next cook has signed in to household_2.
    const answered = createDeferred<undefined>();
    const upsert = server.client.upsertShoppingItems.getMockImplementation();
    server.client.upsertShoppingItems.mockImplementationOnce(
      async (input: { items: ShoppingItem[] }) => {
        const result = await upsert!(input);
        await answered.promise;
        return result;
      }
    );
    await act(async () => {
      latestShoppingList!.setItemChecked("milk", true);
      latestShoppingList!.deleteItem("eggs");
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });
    expect(idsSentTo(server, "household_1")).toEqual(["milk"]);
    await signInTo(renderer, server, nextCook, "household_2");

    await act(async () => {
      answered.resolve(undefined);
      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(0);
    });

    // The first cook's removal was not sent to household_2, and still waits for household_1.
    expect(idsSentTo(server, "household_2")).toEqual([]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["bread", false, "synced"]]);

    await signInTo(renderer, server, firstCook, "household_1");
    expect(server.stored.has("eggs")).toBe(false);
    expect(server.stored.get("milk")).toMatchObject({
      householdId: "household_1",
      item: { checked: true }
    });
    expect(idsSentTo(server, "household_2")).toEqual([]);
    expect(listSummary()).toEqual([["milk", true, "synced"]]);
  });

  it("does not record a list that answers after its account signed out", async () => {
    const server = createHouseholdServer([
      { householdId: "household_1", item: milk },
      { householdId: "household_2", item: bread }
    ]);
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);
    const renderer = await renderProvider();

    // The first cook refreshes; the list is slow to answer. Meanwhile they sign out and the next
    // cook signs in (offline, so their own check can't answer yet).
    const listed = createDeferred<{ items: ShoppingItem[] }>();
    server.client.getShoppingList.mockReturnValueOnce(listed.promise);
    let refreshing: Promise<void> | undefined;
    await act(async () => {
      refreshing = latestShoppingList!.refreshShoppingList();
      await flushAsyncWork();
    });
    server.session.online = false;
    await signInTo(renderer, server, nextCook, "household_2");

    // The answer is household_2's list: the request went out as the next cook.
    await act(async () => {
      listed.resolve({ items: [bread] });
      await refreshing;
      await flushAsyncWork();
    });

    const stored = await storedItems();
    expect(stored.find((item) => item.id === "bread")).toBeUndefined();
    expect(stored.map((item) => [item.id, item.sync.householdId])).toEqual([
      ["milk", "household_1"]
    ]);
  });

  it("does not send a pass's request with the next account's credentials", async () => {
    const server = createHouseholdServer([{ householdId: "household_2", item: bread }]);
    // Like the real client, each request asks for credentials right before it goes out.
    apiMocks.createExtractorApiClient.mockImplementation(
      ({ getHeaders }: { getHeaders: () => Promise<Record<string, string>> }) => ({
        ...server.client,
        upsertShoppingItems: async (input: { items: ShoppingItem[] }) => {
          await getHeaders();
          return server.client.upsertShoppingItems(input);
        }
      })
    );
    const renderer = await renderProvider();

    // The first cook adds limes; fetching the credentials for the push takes a moment, and the
    // next cook has signed in to household_2 by the time they arrive.
    const credentials = createDeferred<Record<string, string>>();
    accountState.getAuthHeaders.mockReturnValueOnce(credentials.promise);
    await act(async () => {
      latestShoppingList!.addItems([{ text: "limes" }]);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });
    await signInTo(renderer, server, nextCook, "household_2");
    await act(async () => {
      credentials.resolve({ authorization: "Bearer next-cook" });
      await flushAsyncWork();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(householdItems(server, "household_2")).toEqual([["bread", null, false]]);
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([["bread", false, "synced"]]);
  });

  it("sets aside only the items the household list refuses, so the rest still sync", async () => {
    const deletedAt = "2026-07-04T11:00:00.000Z";
    // Stored before items recorded their household: only the API can tell which are foreign.
    const storedItem = (id: string, status: "dirty" | "sync_failed", deleted = false) => ({
      addedBy: "user_1",
      checked: false,
      createdAt: updatedAt,
      id,
      sync: { status },
      text: id,
      updatedAt,
      ...(deleted ? { deletedAt, isDeleted: true } : {})
    });
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === "linkdish.shoppingItems.v1"
          ? JSON.stringify([
              storedItem("cream", "sync_failed"),
              storedItem("jam", "dirty"),
              storedItem("butter", "sync_failed"),
              storedItem("salt", "dirty", true),
              storedItem("pepper", "dirty", true)
            ])
          : null
      )
    );
    const server = createHouseholdServer([
      { householdId: "household_1", item: { ...milk, id: "cream", text: "cream" } },
      { householdId: "household_1", item: { ...milk, id: "salt", text: "salt" } },
      { householdId: "household_2", item: { ...milk, id: "pepper", text: "pepper" } },
      { householdId: "household_2", item: bread }
    ]);
    server.session.householdId = "household_2";
    accountState.user = nextCook;
    apiMocks.createExtractorApiClient.mockReturnValue(server.client);

    await renderProvider();

    expect(
      [...server.stored.values()]
        .filter((record) => record.householdId === "household_2")
        .map((record) => record.item.id)
        .sort()
    ).toEqual(["bread", "butter", "jam"]);
    expect(server.stored.get("cream")?.householdId).toBe("household_1");
    expect(server.stored.get("salt")?.householdId).toBe("household_1");
    expect(latestShoppingList?.shoppingError).toBeNull();
    expect(listSummary()).toEqual([
      ["bread", false, "synced"],
      ["butter", false, "synced"],
      ["cream", false, "local_only"],
      ["jam", false, "synced"]
    ]);
    // The copy's id comes from the original's, so a retried set-aside can't make a second one.
    expect(latestShoppingList?.shoppingItems.find((item) => item.text === "cream")?.id).toBe(
      setAsideShoppingItemId("cream", "household_2")
    );

    // Nothing is left that the household list would refuse again.
    server.client.upsertShoppingItems.mockClear();
    server.client.deleteShoppingItems.mockClear();
    await act(async () => {
      await latestShoppingList!.refreshShoppingList();
    });
    expect(sentIds(server)).toEqual([]);
  });

  it("keeps every change pending when the whole household list is refused", async () => {
    const client = buildClient();
    client.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    client.upsertShoppingItems.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 403, {
        message: "An active LinkDish Family household is required."
      })
    );
    apiMocks.createExtractorApiClient.mockReturnValue(client);

    await renderProvider();
    await act(async () => {
      latestShoppingList!.addItems([{ text: "jam" }, { text: "butter" }]);
      await vi.advanceTimersByTimeAsync(SHOPPING_SYNC_DEBOUNCE_MS);
      await flushAsyncWork();
    });

    expect(client.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(latestShoppingList?.shoppingError).toBe(
      "An active LinkDish Family household is required."
    );
    expect(listSummary()).toEqual([
      ["butter", false, "sync_failed"],
      ["jam", false, "sync_failed"]
    ]);
  });
});
