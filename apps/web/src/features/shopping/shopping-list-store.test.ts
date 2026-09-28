import { upsertShoppingItemsRequestSchema } from "@linkdish/api-contracts";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { getLinkDishWebDb, resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { formatItem } from "./shopping-format";
import {
  addShoppingItems,
  claimShoppingChanges,
  clearAllShoppingItems,
  clearCheckedShoppingItems,
  deleteShoppingItems,
  getShoppingItems,
  getShoppingListSnapshot,
  handleUpsertShoppingSyncResult,
  loadShoppingList,
  mergeIncomingShoppingItems,
  mergeShoppingItems,
  parseManualShoppingLine,
  putShoppingItems,
  recipeIngredientsToShoppingInputs,
  resetShoppingListStoreForTests,
  restoreShoppingItems,
  setShoppingChannelFactoryForTests,
  roundUpCountForShopping,
  setShoppingItemChecked,
  setShoppingListHousehold,
  splitShoppingLines,
  syncShoppingItems,
  toApiShoppingItem,
  updateShoppingItemFromLine,
  useShoppingList,
  type WebShoppingItem
} from "./shopping-list-store";

import type {
  DeleteShoppingItemsRequest,
  UpsertShoppingItemsRequest
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

const apiMocks = vi.hoisted(() => ({
  deleteShoppingItems: vi.fn(),
  getShoppingList: vi.fn(),
  upsertShoppingItems: vi.fn()
}));

vi.mock("../../api/client", () => ({ apiClient: apiMocks }));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

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

const live = async () => getShoppingItems();
const byText = async (text: string) => (await live()).find((item) => item.text === text);

describe("shopping-list-store", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    apiMocks.deleteShoppingItems.mockReset();
    apiMocks.getShoppingList.mockReset();
    apiMocks.upsertShoppingItems.mockReset();

    let uuidIndex = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuidIndex += 1;
      return `00000000-0000-4000-8000-${String(uuidIndex).padStart(12, "0")}`;
    });
  });

  it("opens the v4 database with the shopping store", async () => {
    await getShoppingItems();

    expect(fakeIdb.openCalls[0]).toMatchObject({ name: "linkdish-web", version: 4 });
    expect(fakeIdb.hasStore("shoppingItems")).toBe(true);
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

  it("merges the same thing only when the units can be added", () => {
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

  it("adds amounts with friendly fractions, keeps ranges and every recipe", async () => {
    await addShoppingItems(
      [
        { recipeId: "r1", recipeTitle: "Cookies", text: "2/3 cup brown sugar, packed" },
        { recipeId: "r2", recipeTitle: "Blondies", text: "2/3 cup brown sugar" },
        { recipeId: "r1", recipeTitle: "Cookies", text: "2 cups flour" },
        { recipeId: "r2", recipeTitle: "Blondies", text: "1-2 cups flour" },
        { text: "2 tsp sugar" },
        { text: "1 Tbsp sugar" }
      ],
      { canSync: false }
    );

    const items = await live();
    const brownSugar = items.find((item) => item.text === "brown sugar");
    const flour = items.find((item) => item.text === "flour");
    const sugar = items.find((item) => item.text === "sugar");

    expect(items).toHaveLength(3);
    expect(brownSugar && formatItem(brownSugar)).toBe("1 ⅓ cups brown sugar");
    expect(brownSugar?.recipeTitles).toEqual(["Cookies", "Blondies"]);
    expect(brownSugar?.recipeIds).toEqual(["r1", "r2"]);
    expect(brownSugar?.recipeTitle).toBe("Cookies");
    expect(flour?.qty).toEqual({ max: 4, min: 3 });
    expect(sugar && formatItem(sugar)).toBe("1 ⅔ Tbsp sugar");
  });

  it("brings a bought item back with just the new amount", async () => {
    await addShoppingItems([{ text: "2 lemons" }], { canSync: false });
    const lemons = await byText("lemons");
    await setShoppingItemChecked(lemons?.id ?? "", true, { canSync: false });

    await addShoppingItems([{ text: "3 lemons" }], { canSync: false });

    const items = await live();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ checked: false, qty: 3, text: "lemons" });
  });

  it("writes only the records that changed", async () => {
    await addShoppingItems(
      Array.from({ length: 20 }, (_unused, index) => ({ text: `${index + 1} item-${index}` })),
      { canSync: false }
    );
    const db = await getLinkDishWebDb();
    const originalTransaction = db.transaction.bind(db);
    let puts = 0;
    vi.spyOn(db, "transaction").mockImplementation(((
      ...args: Parameters<typeof db.transaction>
    ) => {
      const tx = originalTransaction(...args);
      const originalObjectStore = tx.objectStore.bind(tx);

      return Object.assign(tx, {
        objectStore: (name: string) => {
          const store = originalObjectStore(name as never) as unknown as {
            put: (value: unknown) => Promise<unknown>;
          };
          const originalPut = store.put.bind(store);
          return Object.assign(store, {
            put: (value: unknown) => {
              puts += 1;
              return originalPut(value as never);
            }
          });
        }
      });
    }) as typeof db.transaction);

    await addShoppingItems([{ text: "4 item-3" }], { canSync: false });

    expect(puts).toBe(1);
    expect((await byText("item-3"))?.qty).toBe(8);
  });

  it("splits a pasted list and keeps typed words when there is no amount", () => {
    const lines = splitShoppingLines(
      "- 2 lemons\n• milk, oat if possible\n\n[ ] 1 cup rice\r\n3. eggs\n  \n"
    );

    expect(lines).toHaveLength(4);
    expect(lines.map(parseManualShoppingLine)).toEqual([
      { qty: 2, text: "lemons" },
      { text: "milk, oat if possible" },
      { qty: 1, text: "rice", unit: "cup" },
      { text: "eggs" }
    ]);
    expect(parseManualShoppingLine("   ")).toBeNull();
  });

  it("edits an item from one line, keeping a note after a comma", async () => {
    await addShoppingItems([{ text: "milk" }], { canSync: false });
    const milk = await byText("milk");

    await updateShoppingItemFromLine(milk?.id ?? "", "2 cups oat milk, unsweetened", {
      canSync: false
    });

    expect(await live()).toEqual([
      expect.objectContaining({ qty: 2, text: "oat milk, unsweetened", unit: "cup" })
    ]);
  });

  it("undoes deletes for local and household items", async () => {
    await addShoppingItems([{ text: "basil" }], { canSync: false });
    await addShoppingItems([{ text: "2 limes" }], { canSync: true, userId: "user-1" });
    const basil = await byText("basil");
    const limes = await byText("limes");

    const removed = await deleteShoppingItems([basil?.id ?? "", limes?.id ?? ""], {
      canSync: true
    });

    expect(removed).toHaveLength(2);
    expect(await live()).toHaveLength(0);
    const all = await getShoppingItems({ includeDeleted: true });
    expect(all).toEqual([
      expect.objectContaining({ isDeleted: true, sync: { status: "dirty" }, text: "limes" })
    ]);

    await restoreShoppingItems(removed);

    const restored = await live();
    expect(restored.map((item) => item.text).sort()).toEqual(["basil", "limes"]);
    expect(restored.find((item) => item.text === "basil")?.sync.status).toBe("local_only");
    expect(restored.find((item) => item.text === "limes")).toMatchObject({
      sync: { status: "dirty" }
    });
    expect(restored.find((item) => item.text === "limes")?.isDeleted).toBeUndefined();
  });

  it("clears the cart or the whole list and hands back what it removed", async () => {
    await addShoppingItems([{ text: "eggs" }, { text: "bread" }, { text: "jam" }], {
      canSync: false
    });
    const eggs = await byText("eggs");
    await setShoppingItemChecked(eggs?.id ?? "", true, { canSync: false });

    const cart = await clearCheckedShoppingItems({ canSync: false });
    expect(cart.map((item) => item.text)).toEqual(["eggs"]);
    expect((await live()).map((item) => item.text)).toEqual(["bread", "jam"]);

    const everything = await clearAllShoppingItems({ canSync: false });
    expect(everything).toHaveLength(2);
    expect(await live()).toEqual([]);
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
    expect(unchecked).toMatchObject({ checked: false, checkedBy: null, sync: { status: "dirty" } });
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

  it("clips items to the household limits so one long item can't fail the batch", async () => {
    await putShoppingItems([
      makeItem({
        id: "long",
        recipeTitle: "R".repeat(300),
        section: "S".repeat(200),
        text: `${"very long item ".repeat(40)}end`,
        unit: "u".repeat(60)
      }),
      makeItem({ id: "normal", text: "lemons" }),
      makeItem({ id: "blank", text: "   " })
    ]);
    const sent: UpsertShoppingItemsRequest[] = [];
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      sent.push(upsertShoppingItemsRequestSchema.parse(input));
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: sent.flatMap((request) => request.items) })
    );

    await syncShoppingItems({ canSync: true, userId: "user-1" });

    expect(sent).toHaveLength(1);
    const long = sent[0]?.items.find((item) => item.id === "long");
    expect(long?.text.length).toBeLessThanOrEqual(200);
    expect(long?.recipeTitle).toHaveLength(200);
    expect(long?.section).toHaveLength(120);
    expect(long?.unit).toHaveLength(40);
    expect(sent[0]?.items.map((item) => item.id).sort()).toEqual(["long", "normal"]);
    const all = await getShoppingItems({ includeDeleted: true });
    expect(all.find((item) => item.id === "blank")?.sync.status).toBe("sync_failed");
    expect(all.find((item) => item.id === "normal")?.sync.status).toBe("synced");
    expect(toApiShoppingItem(makeItem({ text: " " }))).toBeNull();
  });

  it("drops synced items another household member deleted and confirms pushed ones", async () => {
    await putShoppingItems([
      makeItem({ id: "gone", sync: { status: "synced" }, text: "cream" }),
      makeItem({ id: "kept", sync: { status: "synced" }, text: "butter" }),
      makeItem({ id: "new", sync: { status: "dirty" }, text: "jam" })
    ]);
    const pushed: UpsertShoppingItemsRequest["items"] = [];
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      pushed.push(...input.items);
      return Promise.resolve({ ignored: [], items: input.items });
    });
    const kept = toApiShoppingItem(makeItem({ id: "kept", text: "butter" }));
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...(kept ? [kept] : []), ...pushed] })
    );

    await syncShoppingItems({ canSync: true, userId: "user-1" });

    const items = await live();
    expect(items.map((item) => item.id).sort()).toEqual(["kept", "new"]);
    expect(items.every((item) => item.sync.status === "synced")).toBe(true);
  });

  it("sets aside only the items the API says belong to another household", async () => {
    const deletedAt = "2026-07-04T11:00:00.000Z";
    // Written before items recorded their household, so only the API can tell they're foreign.
    await putShoppingItems([
      makeItem({ id: "foreign", text: "cream" }),
      makeItem({ id: "mine", text: "jam" }),
      makeItem({ id: "mine-2", text: "butter" }),
      makeItem({ deletedAt, id: "foreign-gone", isDeleted: true, text: "salt" }),
      makeItem({ deletedAt, id: "mine-gone", isDeleted: true, text: "pepper" })
    ]);
    const otherHousehold = new Set(["foreign", "foreign-gone"]);
    const refuse = () =>
      Promise.reject(
        new ExtractorApiError(
          "Extractor API request failed.",
          403,
          { message: "This shopping item belongs to another household." },
          { serverMessage: "This shopping item belongs to another household." }
        )
      );
    const server = new Map<string, UpsertShoppingItemsRequest["items"][number]>();
    const deleted: string[] = [];
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      if (input.items.some((item) => otherHousehold.has(item.id))) {
        return refuse();
      }

      input.items.forEach((item) => server.set(item.id, item));
      return Promise.resolve({ ignored: [], items: [...server.values()] });
    });
    apiMocks.deleteShoppingItems.mockImplementation((input: DeleteShoppingItemsRequest) => {
      if (input.items.some((item) => otherHousehold.has(item.id))) {
        return refuse();
      }

      deleted.push(...input.items.map((item) => item.id));
      return Promise.resolve({
        deletedItemIds: input.items.map((item) => item.id),
        ignored: [],
        status: "deleted"
      });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...server.values()] })
    );

    await syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" });

    expect([...server.keys()].sort()).toEqual(["mine", "mine-2"]);
    expect(deleted).toEqual(["mine-gone"]);
    expect(apiMocks.getShoppingList).toHaveBeenCalledTimes(1);
    const all = await getShoppingItems({ includeDeleted: true });
    expect(all.map((item) => [item.text, item.sync.status, item.sync.householdId])).toEqual([
      ["cream", "local_only", undefined],
      ["jam", "synced", "h2"],
      ["butter", "synced", "h2"]
    ]);
    expect(all[0]?.id).not.toBe("foreign");

    // Nothing is left that would be refused again.
    apiMocks.upsertShoppingItems.mockClear();
    apiMocks.deleteShoppingItems.mockClear();
    await syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" });
    expect(apiMocks.upsertShoppingItems).not.toHaveBeenCalled();
    expect(apiMocks.deleteShoppingItems).not.toHaveBeenCalled();
  });

  it("sets a refused change aside once when two tabs sync at once", async () => {
    // Written before items recorded their household; the API says it is another household's.
    await putShoppingItems([makeItem({ id: "foreign", text: "cream" })]);
    apiMocks.upsertShoppingItems.mockRejectedValue(
      new ExtractorApiError(
        "Extractor API request failed.",
        403,
        { message: "This shopping item belongs to another household." },
        { serverMessage: "This shopping item belongs to another household." }
      )
    );
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });

    await Promise.all([
      syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" }),
      syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" })
    ]);

    const all = await getShoppingItems({ includeDeleted: true });
    expect(all.map((item) => [item.text, item.sync.status])).toEqual([["cream", "local_only"]]);
    expect(all[0]?.id).not.toBe("foreign");
  });

  it("keeps another household's unsent changes on this device and out of the sync", async () => {
    const deletedAt = new Date().toISOString();
    await putShoppingItems([
      makeItem({
        id: "h1-edit",
        sync: { householdId: "h1", status: "dirty" },
        text: "cream",
        updatedAt: deletedAt
      }),
      makeItem({
        deletedAt,
        id: "h1-gone",
        isDeleted: true,
        sync: { householdId: "h1", status: "dirty" },
        text: "salt"
      }),
      makeItem({ id: "mine", sync: { householdId: "h2", status: "dirty" }, text: "jam" })
    ]);
    const server = new Map<string, UpsertShoppingItemsRequest["items"][number]>();
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      input.items.forEach((item) => server.set(item.id, item));
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...server.values()] })
    );

    // Two tabs sync with h2 at once.
    await Promise.all([
      syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" }),
      syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" })
    ]);

    expect([...server.keys()]).toEqual(["mine"]);
    expect(apiMocks.deleteShoppingItems).not.toHaveBeenCalled();
    const all = await getShoppingItems({ includeDeleted: true, includeOtherHouseholds: true });
    expect(all.map((item) => [item.id, item.sync.status, item.sync.householdId])).toEqual([
      ["h1-edit", "dirty", "h1"],
      ["h1-gone", "dirty", "h1"],
      ["mine", "synced", "h2"]
    ]);
  });

  it("drops unsent changes kept for another household once they are 30 days old", async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    await putShoppingItems([
      makeItem({
        id: "h1-stale",
        sync: { householdId: "h1", status: "dirty" },
        text: "cream",
        updatedAt: daysAgo(31)
      }),
      makeItem({
        id: "h1-stale-refused",
        sync: { householdId: "h1", lastError: "Refused", status: "sync_failed" },
        text: "salt",
        updatedAt: daysAgo(45)
      }),
      makeItem({
        id: "h1-recent",
        sync: { householdId: "h1", status: "dirty" },
        text: "eggs",
        updatedAt: daysAgo(29)
      }),
      makeItem({
        id: "h2-stale",
        sync: { householdId: "h2", status: "dirty" },
        text: "jam",
        updatedAt: daysAgo(31)
      }),
      makeItem({
        id: "local-stale",
        sync: { status: "local_only" },
        text: "basil",
        updatedAt: daysAgo(90)
      })
    ]);
    const server = new Map<string, UpsertShoppingItemsRequest["items"][number]>();
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      input.items.forEach((item) => server.set(item.id, item));
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...server.values()] })
    );

    await syncShoppingItems({ canSync: true, householdId: "h2", userId: "user-1" });

    expect([...server.keys()]).toEqual(["h2-stale"]);
    const all = await getShoppingItems({ includeDeleted: true, includeOtherHouseholds: true });
    expect(all.map((item) => [item.id, item.sync.status, item.sync.householdId])).toEqual([
      ["h1-recent", "dirty", "h1"],
      ["h2-stale", "synced", "h2"],
      ["local-stale", "local_only", undefined]
    ]);
  });

  it("never sends another account's unsent item that names no household", async () => {
    const stale = new Date(Date.now() - 90 * 86_400_000).toISOString();
    // Written before changes recorded their household: u9 added figs and never sent them, and
    // removed its salt.
    await putShoppingItems([
      makeItem({ addedBy: "u9", id: "figs", text: "figs", updatedAt: stale }),
      makeItem({
        addedBy: "u9",
        deletedAt: new Date().toISOString(),
        id: "salt",
        isDeleted: true,
        text: "salt"
      }),
      makeItem({ addedBy: "u1", id: "jam", text: "jam" }),
      makeItem({ addedBy: "local", id: "basil", text: "basil" })
    ]);
    const server = new Map<string, UpsertShoppingItemsRequest["items"][number]>();
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      input.items.forEach((item) => server.set(item.id, item));
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...server.values()] })
    );

    // Even when the claim didn't run first (another tab wrote them meanwhile).
    await syncShoppingItems({ canSync: true, householdId: "h2", userId: "u1" });

    expect([...server.keys()].sort()).toEqual(["basil", "jam"]);
    expect(apiMocks.deleteShoppingItems).not.toHaveBeenCalled();
    // Kept (not expired, and not pruned by h2's list) for u9, whose household isn't known here.
    expect(fakeIdb.record<WebShoppingItem>("shoppingItems", "salt")).toMatchObject({
      isDeleted: true,
      sync: { status: "dirty" }
    });
    expect(fakeIdb.record<WebShoppingItem>("shoppingItems", "figs")).toMatchObject({
      sync: { status: "dirty" },
      text: "figs"
    });
    expect(fakeIdb.record<WebShoppingItem>("shoppingItems", "figs")?.sync.householdId).toBe(
      undefined
    );
  });

  it("records a confirmed household on unsent changes that don't name one", async () => {
    await putShoppingItems([
      makeItem({ addedBy: "u1", id: "unknown", sync: { status: "dirty" }, text: "jam" }),
      makeItem({
        addedBy: "local",
        id: "added-signed-out",
        sync: { status: "dirty" },
        text: "oil"
      }),
      // Added by another account before changes named their household: maybe never sent.
      makeItem({ addedBy: "u3", id: "theirs-unsent", sync: { status: "dirty" }, text: "figs" }),
      makeItem({
        addedBy: "u3",
        id: "theirs-changed-by-me",
        sync: { changedBy: "u1", status: "dirty" },
        text: "rice"
      }),
      makeItem({ id: "synced", sync: { status: "synced" }, text: "bread" }),
      makeItem({ id: "local", sync: { status: "local_only" }, text: "basil" }),
      makeItem({ id: "other", sync: { householdId: "h3", status: "sync_failed" }, text: "salt" }),
      makeItem({
        id: "old-home",
        sync: { changedBy: "u1", householdId: "h1", status: "dirty" },
        text: "eggs"
      }),
      makeItem({
        id: "theirs",
        sync: { changedBy: "u3", householdId: "h1", status: "dirty" },
        text: "cream"
      }),
      makeItem({ id: "signed-out", sync: { householdId: "h1", status: "dirty" }, text: "limes" })
    ]);
    const households = async () =>
      Object.fromEntries(
        (await getShoppingItems({ includeOtherHouseholds: true })).map((item) => [
          item.id,
          item.sync.householdId
        ])
      );

    // u1's household is h2: its own changes for h1 (it has moved) can only go to h2 now. Another
    // account's, and ones made signed out, stay with h1; another account's item that names no
    // household waits for that account.
    await claimShoppingChanges("h2", { userId: "u1" });
    expect(await households()).toEqual({
      "added-signed-out": "h2",
      local: undefined,
      "old-home": "h2",
      other: "h3",
      "signed-out": "h1",
      synced: undefined,
      theirs: "h1",
      "theirs-changed-by-me": "h2",
      "theirs-unsent": undefined,
      unknown: "h2"
    });
    await claimShoppingChanges("h9", { userId: "u3" });
    expect((await households())["theirs-unsent"]).toBe("h9");
    expect(fakeIdb.record<WebShoppingItem>("shoppingItems", "old-home")).toMatchObject({
      sync: { changedBy: "u1", householdId: "h2", status: "dirty" },
      text: "eggs"
    });
  });

  it("keeps a change made while a household was being recorded on the list", async () => {
    await putShoppingItems([
      makeItem({ id: "bread", sync: { changedBy: "u1", status: "dirty" }, text: "bread" })
    ]);
    // The check-off lands after the claim has read the list, before it writes.
    fakeIdb.afterNextGetAll("shoppingItems", async () => {
      await setShoppingItemChecked("bread", true, { canSync: true, userId: "u1" });
    });

    await claimShoppingChanges("h1", { userId: "u1" });

    expect(fakeIdb.record<WebShoppingItem>("shoppingItems", "bread")).toMatchObject({
      checked: true,
      checkedBy: "u1",
      sync: { householdId: "h1", status: "dirty" }
    });
  });

  it("leaves records kept for another household out of the list, merges and edits", async () => {
    await putShoppingItems([
      makeItem({
        id: "milk-h1",
        qty: 1,
        sync: { householdId: "h1", status: "synced" },
        text: "milk",
        unit: "cup"
      }),
      makeItem({ id: "eggs-h1", sync: { householdId: "h1", status: "dirty" }, text: "eggs" })
    ]);
    await loadShoppingList();
    expect(getShoppingListSnapshot().items).toHaveLength(2);

    setShoppingListHousehold("h2");
    await waitFor(() => expect(getShoppingListSnapshot().items).toEqual([]));
    expect(await getShoppingItems()).toEqual([]);

    const h2 = { canSync: true, householdId: "h2", userId: "u2" };
    await addShoppingItems([{ recipeId: "r1", text: "2 cups milk" }], h2);
    expect(await setShoppingItemChecked("eggs-h1", true, h2)).toBeUndefined();
    expect(await updateShoppingItemFromLine("eggs-h1", "12 eggs", h2)).toBeUndefined();
    expect(await deleteShoppingItems(["eggs-h1"], h2)).toEqual([]);

    expect((await getShoppingItems()).map((item) => [item.text, item.qty, item.sync])).toEqual([
      ["milk", 2, { changedBy: "u2", householdId: "h2", status: "dirty" }]
    ]);
    expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["milk"]);
    const all = await getShoppingItems({ includeDeleted: true, includeOtherHouseholds: true });
    expect(all.find((item) => item.id === "milk-h1")).toMatchObject({ qty: 1 });
    expect(all.find((item) => item.id === "eggs-h1")).toMatchObject({
      checked: false,
      sync: { householdId: "h1", status: "dirty" },
      text: "eggs"
    });

    // Merging on its own also leaves them alone.
    const merged = mergeIncomingShoppingItems(
      all.filter((item) => item.sync.householdId === "h1"),
      [makeItem({ id: "more-milk", qty: 1, sync: { status: "dirty" }, text: "milk", unit: "cup" })],
      h2
    );
    expect([...merged.changedIds]).toEqual(["more-milk"]);

    // Signed in without a known household (none, or not checked yet): no household's records.
    setShoppingListHousehold(null, { signedIn: true });
    await waitFor(() => expect(getShoppingListSnapshot().items).toEqual([]));
    const u3 = { canSync: false, userId: "u3" };
    await addShoppingItems([{ text: "1 cup milk" }], u3);
    expect(await setShoppingItemChecked("milk-h1", true, u3)).toBeUndefined();
    expect((await getShoppingItems()).map((item) => [item.text, item.qty, item.sync])).toEqual([
      ["milk", 1, { status: "local_only" }]
    ]);

    // Signed out, the whole list on this device shows again.
    setShoppingListHousehold(null);
    await waitFor(() => expect(getShoppingListSnapshot().items).toHaveLength(4));
  });

  it("keeps failing the sync, and every change, when the whole household is refused", async () => {
    await putShoppingItems([makeItem({ id: "mine", text: "jam" })]);
    const refused = new ExtractorApiError(
      "Extractor API request failed.",
      403,
      { message: "An active LinkDish Family household is required." },
      { serverMessage: "An active LinkDish Family household is required." }
    );
    apiMocks.upsertShoppingItems.mockRejectedValue(refused);

    await expect(
      syncShoppingItems({ canSync: true, householdId: "h1", userId: "user-1" })
    ).rejects.toBe(refused);

    expect(apiMocks.upsertShoppingItems).toHaveBeenCalledTimes(1);
    expect(await getShoppingItems()).toEqual([
      expect.objectContaining({ id: "mine", sync: { status: "dirty" } })
    ]);
  });

  it("records the household an item belongs to without sending it", async () => {
    await addShoppingItems([{ text: "jam" }], { canSync: true, householdId: "h1", userId: "u1" });
    const [jam] = await getShoppingItems();
    expect(jam?.sync).toEqual({ changedBy: "u1", householdId: "h1", status: "dirty" });

    // Signed out: still h1's change, never re-homed by a local edit, and no longer only u1's (so
    // it doesn't follow u1 to another household).
    const edited = await updateShoppingItemFromLine(jam?.id ?? "", "2 jars jam", {
      canSync: false
    });
    expect(edited?.sync).toEqual({ householdId: "h1", status: "dirty" });
    expect(toApiShoppingItem(edited ?? makeItem({}))).not.toHaveProperty("sync");
    expect(JSON.stringify(toApiShoppingItem(edited ?? makeItem({})))).not.toContain("h1");
  });

  it("writes, re-renders and broadcasts nothing when the household list is unchanged", async () => {
    const postMessage = vi.fn();
    setShoppingChannelFactoryForTests(() => ({ close: vi.fn(), onmessage: null, postMessage }));
    await putShoppingItems([
      makeItem({ id: "a", sync: { status: "dirty" }, text: "butter" }),
      makeItem({ id: "b", sync: { status: "dirty" }, text: "jam" })
    ]);
    let server: UpsertShoppingItemsRequest["items"] = [];
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      server = input.items;
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() => Promise.resolve({ items: server }));
    await syncShoppingItems({ canSync: true, householdId: "h1", userId: "user-1" });
    await loadShoppingList();

    const db = await getLinkDishWebDb();
    const put = vi.spyOn(db, "put");
    const snapshot = getShoppingListSnapshot();
    postMessage.mockClear();

    // The 30-second poll: nothing to push, and the server returns exactly what we have.
    await syncShoppingItems({ canSync: true, householdId: "h1", userId: "user-1" });

    expect(put).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(getShoppingListSnapshot()).toBe(snapshot);
    setShoppingChannelFactoryForTests(null);
  });

  it("keeps a reactive in-memory copy that follows writes", async () => {
    await loadShoppingList();
    expect(getShoppingListSnapshot().status).toBe("ready");

    await addShoppingItems([{ text: "3 lemons" }], { canSync: false });
    expect(getShoppingListSnapshot().items.map((item) => item.text)).toEqual(["lemons"]);

    const { result } = renderHook(() => useShoppingList());
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  it("rounds counts up to whole things to buy", () => {
    expect(roundUpCountForShopping({ qty: 0.625, text: "small onion" })).toEqual({
      qty: 1,
      text: "small onion"
    });
    expect(roundUpCountForShopping({ qty: 2.5, text: "large eggs" }).qty).toBe(3);
    expect(roundUpCountForShopping({ qty: { max: 1.5, min: 0.5 }, unit: "clove" }).qty).toEqual({
      max: 2,
      min: 1
    });
    expect(roundUpCountForShopping({ qty: 0.5, unit: "cup" }).qty).toBe(0.5);
  });

  it("builds recipe inputs with the recipe page's scale and units", () => {
    const recipe = {
      ingredients: [{ text: "1 cup flour" }, { section: "Glaze", text: "2 tbsp milk" }],
      title: "Scones"
    } as Pick<Recipe, "ingredients" | "title">;

    expect(recipeIngredientsToShoppingInputs(recipe, "r1", { factor: 2 })).toEqual([
      { recipeId: "r1", recipeTitle: "Scones", text: "2 cups flour" },
      { recipeId: "r1", recipeTitle: "Scones", section: "Glaze", text: "4 Tbsp milk" }
    ]);
    expect(
      recipeIngredientsToShoppingInputs(recipe, "r1", { factor: 1, unitPreference: "alternate" })[0]
        ?.text
    ).toMatch(/ml|g/u);
  });
});
