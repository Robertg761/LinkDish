import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  forgetJournaledCheck,
  journalCheck,
  readCheckJournal,
  SHOPPING_CHECK_JOURNAL_KEY
} from "./shopping-check-journal";
import {
  deleteShoppingItems,
  getShoppingItems,
  getShoppingListSnapshot,
  loadShoppingList,
  putShoppingItems,
  resetShoppingListStoreForTests,
  setShoppingItemChecked,
  syncShoppingItems,
  type WebShoppingItem
} from "./shopping-list-store";

const apiMocks = vi.hoisted(() => ({
  deleteShoppingItems: vi.fn(),
  getShoppingList: vi.fn(),
  upsertShoppingItems: vi.fn()
}));

vi.mock("../../api/client", () => ({ apiClient: apiMocks }));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const ADDED_AT = "2026-11-03T10:00:00.000Z";
const TAPPED_AT = "2026-11-03T10:05:00.000Z";
const LATER = "2026-11-03T10:06:00.000Z";

const item = (overrides: Partial<WebShoppingItem> = {}): WebShoppingItem => ({
  addedBy: "local",
  checked: false,
  checkedBy: null,
  createdAt: ADDED_AT,
  id: "lemons",
  sync: { status: "local_only" },
  text: "lemons",
  updatedAt: ADDED_AT,
  ...overrides
});

/** What a page leaves behind when a reload aborts its write: the tap, and the old record. */
const tapThenReload = (overrides: Partial<Parameters<typeof journalCheck>[1]> = {}) => {
  journalCheck("lemons", { canSync: false, checked: true, updatedAt: TAPPED_AT, ...overrides });
  resetLinkDishWebDbForTests();
  resetShoppingListStoreForTests();
};

describe("check-offs across a reload", () => {
  beforeEach(() => {
    localStorage.clear();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    apiMocks.getShoppingList.mockReset();
    apiMocks.upsertShoppingItems.mockReset();
  });

  it("notes the tap before the write and forgets it once the write is in", async () => {
    await putShoppingItems([item()]);

    const write = setShoppingItemChecked("lemons", true, { canSync: false });

    expect(readCheckJournal().lemons).toMatchObject({ checked: true });
    await write;
    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("gives the item the time journaled with the tap", async () => {
    await putShoppingItems([item()]);

    const write = setShoppingItemChecked("lemons", true, { canSync: false });
    const journaled = readCheckJournal().lemons;

    expect((await write)?.updatedAt).toBe(journaled?.updatedAt);
  });

  it("shows a check-off whose write the reload aborted on the first load", async () => {
    await putShoppingItems([item()]);
    tapThenReload();

    await loadShoppingList();

    expect(getShoppingListSnapshot().items[0]).toMatchObject({
      checked: true,
      checkedBy: "local",
      updatedAt: TAPPED_AT
    });
    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("puts an item back when that was the tap the reload cut off", async () => {
    await putShoppingItems([item({ checked: true, checkedBy: "local" })]);
    tapThenReload({ checked: false });

    expect((await getShoppingItems())[0]).toMatchObject({ checked: false, checkedBy: null });
  });

  it("sends a household check-off on the first sync, as the account that made it", async () => {
    await putShoppingItems([
      item({ sync: { householdId: "h1", lastSyncedAt: ADDED_AT, status: "synced" } })
    ]);
    tapThenReload({ canSync: true, householdId: "h1", userId: "u1" });
    apiMocks.upsertShoppingItems.mockResolvedValue({ ignored: [], items: [] });
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });

    await syncShoppingItems({ canSync: true, householdId: "h1", userId: "u1" });

    expect(apiMocks.upsertShoppingItems).toHaveBeenCalledWith({
      items: [expect.objectContaining({ checked: true, checkedBy: "u1", updatedAt: TAPPED_AT })]
    });
  });

  it("keeps a change made after the tap", async () => {
    await putShoppingItems([item({ text: "limes", updatedAt: LATER })]);
    tapThenReload();

    expect((await getShoppingItems())[0]).toMatchObject({ checked: false, text: "limes" });
    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("leaves an item alone when the write got in before the reload", async () => {
    const stored = item({ checked: true, checkedBy: "local", updatedAt: TAPPED_AT });
    await putShoppingItems([stored]);
    tapThenReload();

    expect((await getShoppingItems())[0]).toEqual(stored);
  });

  it("drops a tap on an item that has since gone", async () => {
    await putShoppingItems([item()]);
    await deleteShoppingItems(["lemons"], { canSync: false });
    tapThenReload();

    expect(await getShoppingItems()).toEqual([]);
    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("doesn't apply a tap to another household's item", async () => {
    const stored = item({ sync: { householdId: "h2", status: "synced" } });
    await putShoppingItems([stored]);
    tapThenReload({ canSync: true, householdId: "h1", userId: "u1" });

    expect(await getShoppingItems()).toContainEqual(stored);
  });

  it("forgets a tap whose write failed, so the next load can't redo what the page undid", async () => {
    await putShoppingItems([item()]);
    fakeIdb.failNextPut("shoppingItems", new Error("disk full"));

    await expect(setShoppingItemChecked("lemons", true, { canSync: false })).rejects.toThrow(
      "disk full"
    );

    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("still shows the list when a tap can't be applied, and tries again on the next read", async () => {
    await putShoppingItems([item()]);
    tapThenReload();
    fakeIdb.failNextPut("shoppingItems", new Error("disk full"));

    expect((await getShoppingItems())[0]).toMatchObject({ checked: false });
    expect(readCheckJournal().lemons).toBeDefined();

    expect((await getShoppingItems())[0]).toMatchObject({ checked: true });
    expect(localStorage.getItem(SHOPPING_CHECK_JOURNAL_KEY)).toBeNull();
  });

  it("keeps a later tap when the earlier one's write finishes", () => {
    journalCheck("lemons", { canSync: false, checked: true, updatedAt: TAPPED_AT });
    journalCheck("lemons", { canSync: false, checked: false, updatedAt: LATER });

    forgetJournaledCheck("lemons", TAPPED_AT);

    expect(readCheckJournal().lemons).toMatchObject({ checked: false, updatedAt: LATER });
  });

  it("ignores a journal it can't read", async () => {
    await putShoppingItems([item()]);

    for (const unreadable of ["not json", "null", '{"lemons":{"checked":"yes"}}']) {
      localStorage.setItem(SHOPPING_CHECK_JOURNAL_KEY, unreadable);
      resetShoppingListStoreForTests();

      expect((await getShoppingItems())[0]).toMatchObject({ checked: false });
    }
  });
});
