import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import {
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SHOPPING_ITEMS_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../../storage/testing/fake-idb-isolation";
import {
  writeInOtherTabAfterNextGetAll,
  writeInOtherTabAfterNextRead
} from "../../storage/testing/two-tabs";

import {
  addParsedShoppingItems,
  applyRemoteShoppingItems,
  claimShoppingChanges,
  clearCheckedShoppingItems,
  deleteShoppingItems,
  handleDeleteShoppingSyncResult,
  handleUpsertShoppingSyncResult,
  pruneStaleShoppingRecords,
  resetShoppingListStoreForTests,
  restoreShoppingItems,
  setShoppingItemChecked,
  syncShoppingItems,
  updateShoppingItemFromLine
} from "./shopping-list-store";

import type { WebShoppingItem } from "./shopping-list-store";

const apiMocks = vi.hoisted(() => ({
  deleteShoppingItems: vi.fn(),
  getShoppingList: vi.fn(),
  upsertShoppingItems: vi.fn()
}));

vi.mock("../../api/client", () => ({ apiClient: apiMocks }));
vi.mock(
  "idb",
  async () => (await import("../../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);

const STORE = SHOPPING_ITEMS_STORE_NAME;
const EARLIER = "2026-07-04T10:00:00.000Z";
/** This tab's account and the other tab's, both in household h1. */
const ME = { canSync: true, householdId: "h1", userId: "u1" };
const PARTNER = { canSync: true, householdId: "h1", userId: "u2" };

/** Another tab on the same database: fresh copies of the connection and the list's cache. */
const openOtherTab = async () => {
  vi.resetModules();
  const store = await import("./shopping-list-store");
  store.setShoppingChannelFactoryForTests(() => null);
  const connection = await (await import("../../storage/linkdish-db")).getLinkDishWebDb();
  return { connection, store };
};

const item = (overrides: Partial<WebShoppingItem> & { id: string }): WebShoppingItem => ({
  addedBy: "u1",
  checked: false,
  checkedBy: null,
  createdAt: EARLIER,
  sync: { householdId: "h1", lastSyncedAt: EARLIER, status: "synced" },
  text: overrides.id,
  updatedAt: EARLIER,
  ...overrides
});

const stored = (id: string) => fakeIdb.record<WebShoppingItem>(STORE, id);

const otherHouseholdRefusal = () =>
  new ExtractorApiError(
    "Extractor API request failed.",
    403,
    { message: "This shopping item belongs to another household." },
    { serverMessage: "This shopping item belongs to another household." }
  );

describe("shopping-list writes from two tabs", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    apiMocks.deleteShoppingItems.mockReset();
    apiMocks.getShoppingList.mockReset();
    apiMocks.upsertShoppingItems.mockReset();
    await getLinkDishWebDb();
  });

  it("keeps a check-off from the other tab and this tab's edit of the same item", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk", qty: 1, unit: "cup" })]);
    const other = await openOtherTab();

    const checked = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "milk",
      other.connection,
      () => other.store.setShoppingItemChecked("milk", true, PARTNER)
    );
    await Promise.all([updateShoppingItemFromLine("milk", "2 cups oat milk", ME), checked]);

    expect(stored("milk")).toMatchObject({
      checked: true,
      checkedBy: "u2",
      qty: 2,
      sync: { householdId: "h1", status: "dirty" },
      text: "oat milk",
      unit: "cup"
    });
  });

  it("keeps this tab's check-off when the other tab changes the amount", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk", qty: 1, unit: "cup" })]);
    const other = await openOtherTab();

    const edited = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "milk",
      other.connection,
      () => other.store.updateShoppingItemFromLine("milk", "3 cups milk", PARTNER)
    );
    await Promise.all([setShoppingItemChecked("milk", true, ME), edited]);

    expect(stored("milk")).toMatchObject({ checked: true, checkedBy: "u1", qty: 3, text: "milk" });
  });

  it("adds a recipe's amount to an item the other tab checks off at the same moment", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk", qty: 1, unit: "cup" })]);
    const other = await openOtherTab();

    const checked = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.setShoppingItemChecked("milk", true, PARTNER)
    );
    await Promise.all([
      addParsedShoppingItems(
        [
          { qty: 1, recipeIds: ["pancakes"], recipeTitles: ["Pancakes"], text: "milk", unit: "cup" }
        ],
        ME
      ),
      checked
    ]);

    // The add merged first; the check-off then applied to the merged item.
    expect(stored("milk")).toMatchObject({
      checked: true,
      qty: 2,
      recipeIds: ["pancakes"],
      unit: "cup"
    });
  });

  it("applies the household's newer copy and the other tab's check-off together", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" })]);
    const other = await openOtherTab();

    const checked = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.setShoppingItemChecked("milk", true, PARTNER)
    );
    await Promise.all([
      applyRemoteShoppingItems(
        [
          {
            addedBy: "u1",
            checked: false,
            id: "milk",
            text: "oat milk",
            updatedAt: "2026-07-04T11:00:00.000Z"
          }
        ],
        { householdId: "h1", prune: true }
      ),
      checked
    ]);

    expect(stored("milk")).toMatchObject({
      checked: true,
      sync: { householdId: "h1", status: "dirty" },
      text: "oat milk"
    });
  });

  it("keeps this tab's deletion when the other tab edits the item at the same moment", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" })]);
    const other = await openOtherTab();

    const edited = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "milk",
      other.connection,
      () => other.store.updateShoppingItemFromLine("milk", "oat milk", PARTNER)
    );
    const [removed, edit] = await Promise.all([deleteShoppingItems(["milk"], ME), edited]);

    // The edit waited for the deletion and found the item gone (it used to land in between and
    // bring the item back).
    expect(edit).toBeUndefined();
    expect(removed).toEqual([expect.objectContaining({ id: "milk", text: "milk" })]);
    expect(stored("milk")).toMatchObject({ isDeleted: true, sync: { status: "dirty" } });
  });

  it("clears the cart without clearing an item the other tab takes back out", async () => {
    fakeIdb.seed(STORE, [
      item({ checked: true, checkedBy: "u1", id: "milk" }),
      item({ checked: true, checkedBy: "u1", id: "eggs" })
    ]);
    const other = await openOtherTab();

    const unchecked = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.setShoppingItemChecked("milk", false, PARTNER)
    );
    const [removed, uncheck] = await Promise.all([clearCheckedShoppingItems(ME), unchecked]);

    // The uncheck waited for the clear and found the item gone. (It used to land between the
    // clear's read and its write, report success, and have its item cleared anyway.)
    expect(uncheck).toBeUndefined();
    expect(removed.map((record) => record.id).sort()).toEqual(["eggs", "milk"]);
    expect(stored("milk")).toMatchObject({ checked: true, isDeleted: true });
  });

  it("keeps an edit the other tab makes while this tab marks refused changes", async () => {
    const pending = { householdId: "h1", status: "dirty" } as const;
    fakeIdb.seed(STORE, [item({ id: "milk", sync: pending }), item({ id: "eggs", sync: pending })]);
    const other = await openOtherTab();

    const edited = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "milk",
      other.connection,
      () => other.store.updateShoppingItemFromLine("milk", "oat milk", PARTNER)
    );
    const ignored = (id: string) => ({
      existingUpdatedAt: "2026-07-04T12:00:00.000Z",
      id,
      reason: "older_update" as const
    });
    await Promise.all([
      handleUpsertShoppingSyncResult(
        { ignored: [ignored("milk"), ignored("eggs")], items: [] },
        { householdId: "h1" }
      ),
      edited
    ]);

    expect(stored("milk")).toMatchObject({ sync: { status: "dirty" }, text: "oat milk" });
    expect(stored("eggs")).toMatchObject({ sync: { status: "sync_failed" } });
  });

  it("keeps an item Undo brought back while its deletion was being sent", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" }), item({ id: "eggs" })]);
    const removed = await deleteShoppingItems(["milk", "eggs"], ME);
    const other = await openOtherTab();
    // The deletion is on its way to the household when Undo puts the milk back.
    await other.store.restoreShoppingItems(removed.filter((record) => record.id === "milk"));

    await handleDeleteShoppingSyncResult({
      deletedItemIds: ["milk", "eggs"],
      ignored: [],
      status: "deleted"
    });

    expect(stored("milk")).toMatchObject({ sync: { status: "dirty" }, text: "milk" });
    expect(stored("milk")?.isDeleted).toBeUndefined();
    expect(stored("eggs")).toBeUndefined();
  });

  it("sets a refused change aside without losing it to an edit in the other tab", async () => {
    // Written before items recorded their household; the API says it is another household's.
    fakeIdb.seed(STORE, [item({ id: "foreign", sync: { status: "dirty" }, text: "cream" })]);
    apiMocks.upsertShoppingItems.mockRejectedValue(otherHouseholdRefusal());
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });
    const other = await openOtherTab();

    const edited = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "foreign",
      other.connection,
      () => other.store.updateShoppingItemFromLine("foreign", "double cream", PARTNER)
    );
    const [, edit] = await Promise.all([
      syncShoppingItems({ canSync: true, householdId: "h1", userId: "u1" }),
      edited
    ]);

    // The edit waited for the set-aside, so it never brought the refused item back.
    expect(edit).toBeUndefined();
    expect(stored("foreign")).toBeUndefined();
    expect(fakeIdb.records<WebShoppingItem>(STORE)).toEqual([
      expect.objectContaining({ sync: { status: "local_only" }, text: "cream" })
    ]);
  });

  it("marks an item that can't be shared, keeping the other tab's edit of it", async () => {
    const id = "x".repeat(121);
    fakeIdb.seed(STORE, [item({ id, sync: { householdId: "h1", status: "dirty" }, text: "jam" })]);
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });
    const other = await openOtherTab();

    const edited = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.updateShoppingItemFromLine(id, "apricot jam", PARTNER)
    );
    await Promise.all([
      syncShoppingItems({ canSync: true, householdId: "h1", userId: "u1" }),
      edited
    ]);

    expect(stored(id)).toMatchObject({
      sync: { lastError: "This item can't be shared with your household.", status: "sync_failed" },
      text: "apricot jam"
    });
  });

  it("does not prune an item the other tab's Undo brings back meanwhile", async () => {
    const deletedAt = new Date().toISOString();
    // A tombstone that will never sync (written by an older version), about to be pruned.
    fakeIdb.seed(STORE, [
      item({
        deletedAt,
        id: "basil",
        isDeleted: true,
        sync: { status: "local_only" },
        updatedAt: deletedAt
      })
    ]);
    const other = await openOtherTab();

    const restored = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.restoreShoppingItems([
        item({ deletedAt, id: "basil", sync: { status: "local_only" } })
      ])
    );
    const [pruned] = await Promise.all([
      pruneStaleShoppingRecords({ householdId: "h1" }),
      restored
    ]);

    expect(pruned).toBe(1);
    expect(stored("basil")).toMatchObject({ sync: { status: "local_only" }, text: "basil" });
    expect(stored("basil")?.isDeleted).toBeUndefined();
  });

  it("records the household without losing a check-off made meanwhile", async () => {
    fakeIdb.seed(STORE, [item({ id: "bread", sync: { changedBy: "u1", status: "dirty" } })]);
    const other = await openOtherTab();

    const checked = writeInOtherTabAfterNextGetAll(STORE, other.connection, () =>
      other.store.setShoppingItemChecked("bread", true, ME)
    );
    await Promise.all([claimShoppingChanges("h1", { userId: "u1" }), checked]);

    expect(stored("bread")).toMatchObject({
      checked: true,
      sync: { householdId: "h1", status: "dirty" }
    });
  });
});

describe("Undo for shopping deletions", () => {
  /** Moves the clock to `time` on 2026-07-05 (only Date is faked: the fake's commits need timers). */
  const at = (time: string) => {
    vi.setSystemTime(new Date(`2026-07-05T${time}:00.000Z`));
    return `2026-07-05T${time}:00.000Z`;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("09:00");
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    await getLinkDishWebDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts items back over this tab's own deletion", async () => {
    fakeIdb.seed(STORE, [
      item({ id: "milk" }),
      item({ id: "basil", sync: { status: "local_only" } })
    ]);
    const removed = await deleteShoppingItems(["milk", "basil"], ME);
    const restoredAt = at("09:01");

    const restored = await restoreShoppingItems(removed);

    expect(restored.map((record) => record.id).sort()).toEqual(["basil", "milk"]);
    expect(stored("milk")).toMatchObject({
      sync: { householdId: "h1", status: "dirty" },
      updatedAt: restoredAt
    });
    expect(stored("milk")?.isDeleted).toBeUndefined();
    expect(stored("milk")?.deletedAt).toBeUndefined();
    expect(stored("basil")).toMatchObject({ sync: { status: "local_only" }, text: "basil" });
  });

  it("keeps a newer copy the household brought back before Undo", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" }), item({ id: "eggs" })]);
    const removed = await deleteShoppingItems(["milk", "eggs"], ME);
    const other = await openOtherTab();
    // Someone in the household renamed the milk after this tab deleted it; a pull brings it back.
    const renamedAt = "2026-07-05T09:01:00.000Z";
    await other.store.applyRemoteShoppingItems(
      [{ addedBy: "u2", checked: false, id: "milk", text: "oat milk", updatedAt: renamedAt }],
      { householdId: "h1" }
    );
    at("09:02");

    const restored = await restoreShoppingItems(removed);

    expect(restored.map((record) => record.id)).toEqual(["eggs"]);
    expect(stored("milk")).toMatchObject({
      sync: { status: "synced" },
      text: "oat milk",
      updatedAt: renamedAt
    });
    expect(stored("milk")?.isDeleted).toBeUndefined();
    expect(stored("eggs")?.isDeleted).toBeUndefined();
  });

  it("puts back an unsent edit over an older household copy pulled in after the deletion", async () => {
    fakeIdb.seed(STORE, [
      item({
        id: "milk",
        sync: { changedBy: "u1", householdId: "h1", status: "dirty" },
        text: "oat milk",
        updatedAt: "2026-07-05T08:30:00.000Z"
      })
    ]);
    // Removed signed out (so straight away), then a pull brings the household's older copy back.
    const removed = await deleteShoppingItems(["milk"], { canSync: false });
    at("09:01");
    await applyRemoteShoppingItems(
      [{ addedBy: "u1", checked: false, id: "milk", text: "milk", updatedAt: EARLIER }],
      { householdId: "h1" }
    );
    const restoredAt = at("09:02");

    const restored = await restoreShoppingItems(removed);

    expect(restored.map((record) => record.id)).toEqual(["milk"]);
    expect(stored("milk")).toMatchObject({
      sync: { changedBy: "u1", householdId: "h1", status: "dirty" },
      text: "oat milk",
      updatedAt: restoredAt
    });
  });

  it("puts an item back before a check-off the other tab starts while Undo looks", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" })]);
    const removed = await deleteShoppingItems(["milk"], ME);
    const other = await openOtherTab();
    at("09:01");

    // The check-off starts right after Undo read the tombstone: it waits for Undo's write
    // instead of finding the item deleted.
    const checked = writeInOtherTabAfterNextRead(
      await getLinkDishWebDb(),
      STORE,
      "milk",
      other.connection,
      () => other.store.setShoppingItemChecked("milk", true, PARTNER)
    );
    await Promise.all([restoreShoppingItems(removed), checked]);

    expect(stored("milk")).toMatchObject({ checked: true, checkedBy: "u2" });
    expect(stored("milk")?.isDeleted).toBeUndefined();
  });

  it("does not undo a deletion made after this tab's", async () => {
    fakeIdb.seed(STORE, [item({ id: "milk" })]);
    const removed = await deleteShoppingItems(["milk"], ME);
    const other = await openOtherTab();
    // The item came back from the household, and the other tab deleted it again.
    await other.store.applyRemoteShoppingItems(
      [
        {
          addedBy: "u2",
          checked: false,
          id: "milk",
          text: "oat milk",
          updatedAt: "2026-07-05T09:01:00.000Z"
        }
      ],
      { householdId: "h1" }
    );
    at("09:02");
    await other.store.deleteShoppingItems(["milk"], PARTNER);
    const laterDeletion = stored("milk");
    at("09:03");

    const restored = await restoreShoppingItems(removed);

    expect(restored).toEqual([]);
    expect(laterDeletion).toMatchObject({ isDeleted: true, text: "oat milk" });
    expect(stored("milk")).toEqual(laterDeletion);
  });
});
