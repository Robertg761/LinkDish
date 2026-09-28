import { MAX_SHOPPING_ITEM_TEXT_LENGTH, shoppingItemSchema } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  addShoppingItemsToList,
  applyRemoteShoppingItems,
  belongsToOtherHousehold,
  clearCheckedShoppingItemsInList,
  deleteShoppingItemInList,
  getSyncableDirtyItems,
  groupShoppingItemsByAisle,
  markShoppingItemsSynced,
  parseShoppingItems,
  parseShoppingLine,
  readShoppingItems,
  recipeIngredientsToShoppingInputs,
  serializeShoppingItems,
  setAsideShoppingItems,
  setShoppingItemCheckedInList,
  shoppingTextFromQuantity,
  toApiShoppingItem,
  type MobileShoppingItem
} from "./store";

import type { Recipe } from "@linkdish/recipe-domain";

const now = "2026-07-04T12:00:00.000Z";

const buildItem = (overrides?: Partial<MobileShoppingItem>): MobileShoppingItem => ({
  addedBy: "user_1",
  checked: false,
  checkedBy: null,
  createdAt: now,
  id: "shopping_1",
  sync: {
    status: "dirty"
  },
  text: "milk",
  updatedAt: now,
  ...overrides
});

const buildRecipe = (): Recipe => ({
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: "visible-text",
      ingredients: "visible-text",
      nutrition: null,
      prepTimeMinutes: "visible-text",
      servings: "visible-text",
      steps: "visible-text",
      title: "visible-text"
    },
    missingFields: [],
    notes: [],
    score: 0.94,
    summary: "Confident recipe."
  },
  cookTimeMinutes: 10,
  ingredients: [
    {
      section: "Dressing",
      text: "1/2 tsp salt"
    },
    {
      section: "Dressing",
      text: "2 cups [280 g] flour"
    },
    {
      section: "Finish",
      text: "Pepper to taste"
    }
  ],
  nutrition: null,
  prepTimeMinutes: 5,
  servings: "4 servings",
  sourceType: "article",
  sourceUrl: "https://example.com/salad",
  steps: [{ index: 1, text: "Mix." }],
  title: "House Salad"
});

describe("shopping store helpers", () => {
  it("round-trips shopping items through storage serialization", () => {
    const items = [
      buildItem({
        qty: 2,
        recipeId: "recipe_1",
        recipeTitle: "Soup",
        section: "Produce",
        sync: {
          lastSyncedAt: now,
          status: "synced"
        },
        unit: "cups"
      })
    ];

    expect(parseShoppingItems(serializeShoppingItems(items))).toEqual(items);
  });

  // This test used to pin "cups and tbsp stay separate". The list now merges through the
  // domain's unit-aware addShoppingAmounts (see SHOPPING_MERGE_OPTIONS): the same thing to buy
  // in compatible units (cup + Tbsp, tsp + Tbsp, cup + ml) is one line, while volume and
  // weight (cup vs g) still never merge because that would need a density guess.
  it("merges the same item across compatible units but keeps volume and weight apart", () => {
    const base = addShoppingItemsToList([], [{ text: "1 cup sugar" }], {
      canSync: false,
      now,
      userId: "user_1"
    });
    const merged = addShoppingItemsToList(base, [{ text: "2 cups sugar" }], {
      canSync: false,
      now: "2026-07-04T12:01:00.000Z",
      userId: "user_1"
    });
    const withSpoon = addShoppingItemsToList(merged, [{ text: "4 tbsp sugar" }], {
      canSync: false,
      now: "2026-07-04T12:02:00.000Z",
      userId: "user_1"
    });
    const withWeight = addShoppingItemsToList(withSpoon, [{ text: "100 g sugar" }], {
      canSync: false,
      now: "2026-07-04T12:03:00.000Z",
      userId: "user_1"
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      qty: 3,
      text: "sugar",
      unit: "cup"
    });
    expect(withSpoon).toHaveLength(1);
    expect(withSpoon[0]).toMatchObject({ qty: 3.25, unit: "cup" });
    expect(shoppingTextFromQuantity(withSpoon[0]?.qty, withSpoon[0]?.unit, "sugar")).toBe(
      "3 ¼ cups sugar"
    );
    expect(withWeight).toHaveLength(2);
    expect(withWeight.map((item) => item.unit).sort()).toEqual(["cup", "g"]);
  });

  it("never loses a range when it merges with a plain amount", () => {
    const items = addShoppingItemsToList([], [{ text: "2 tsp salt" }, { text: "1-2 tsp salt" }], {
      canSync: false,
      now,
      userId: "user_1"
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qty: { max: 4, min: 3 }, unit: "tsp" });
    expect(shoppingTextFromQuantity(items[0]?.qty, items[0]?.unit, items[0]?.text ?? "")).toBe(
      "3–4 tsp salt"
    );
  });

  it("merges the same ingredient written differently and re-inflects its name", () => {
    const items = addShoppingItemsToList(
      [],
      [{ text: "1 large egg" }, { text: "2 large eggs, beaten" }],
      { canSync: false, now, userId: "user_1" }
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qty: 3, text: "large eggs" });
  });

  it("prints friendly fractions instead of floating point noise", () => {
    expect(shoppingTextFromQuantity(2 / 3, "cup", "milk")).toBe("⅔ cup milk");
    expect(shoppingTextFromQuantity({ max: 2, min: 1 }, "tsp", "salt")).toBe("1–2 tsp salt");
    expect(shoppingTextFromQuantity(null, null, "Salt")).toBe("Salt");
  });

  it("parses package sizes and prep notes into a clean item", () => {
    expect(parseShoppingLine("1 (15-ounce) can chickpeas, drained")).toEqual({
      qty: 1,
      text: "chickpeas (15-ounce)",
      unit: "can"
    });
    expect(parseShoppingLine("0-1 tsp salt")).toEqual({ qty: 1, text: "salt", unit: "tsp" });
  });

  it("clears checked items, tombstoning the synced ones", () => {
    const items = [
      buildItem({ checked: true, id: "synced", sync: { status: "synced" } }),
      buildItem({ checked: true, id: "local", sync: { status: "local_only" } }),
      buildItem({ checked: false, id: "open", sync: { status: "synced" } })
    ];

    const cleared = clearCheckedShoppingItemsInList(items, {
      canSync: true,
      now: "2026-07-04T12:05:00.000Z",
      userId: "user_1"
    });

    expect(cleared.map((item) => item.id)).toEqual(["synced", "open"]);
    expect(cleared[0]).toMatchObject({
      deletedAt: "2026-07-04T12:05:00.000Z",
      isDeleted: true,
      sync: { status: "dirty" }
    });
    expect(
      clearCheckedShoppingItemsInList(items, { canSync: false }).map((item) => item.id)
    ).toEqual(["open"]);
  });

  it("groups items by aisle in store-walk order", () => {
    const groups = groupShoppingItemsByAisle([
      buildItem({ id: "a", qty: 1, text: "chickpeas (15-ounce)", unit: "can" }),
      buildItem({ id: "b", text: "milk" }),
      buildItem({ id: "c", qty: 2, text: "onions" })
    ]);

    expect(groups.map((group) => [group.category, group.items.map((item) => item.id)])).toEqual([
      ["produce", ["c"]],
      ["dairy-eggs", ["b"]],
      ["canned", ["a"]]
    ]);
    expect(groups[0]?.label).toBe("Produce");
  });

  it("keeps a pending merge when a stale copy with the same timestamp comes back", () => {
    // Another member's device stamped this item ahead of our clock, so merging "3 eggs" into it
    // changes the amount without advancing updatedAt. A sync response computed before the merge
    // still carries the old copy with that same timestamp: it is not this edit coming back.
    const aheadOfThisDevice = "2026-07-04T12:00:30.000Z";
    const eggs = buildItem({
      addedBy: "user_2",
      id: "eggs",
      qty: 2,
      sync: { lastSyncedAt: aheadOfThisDevice, status: "synced" },
      text: "eggs",
      updatedAt: aheadOfThisDevice
    });
    const merged = addShoppingItemsToList([eggs], [{ text: "3 eggs" }], {
      canSync: true,
      now,
      userId: "user_1"
    });

    expect(merged[0]).toMatchObject({
      id: "eggs",
      qty: 5,
      sync: { status: "dirty" },
      updatedAt: aheadOfThisDevice
    });

    const afterStaleResponse = applyRemoteShoppingItems(
      markShoppingItemsSynced(merged, new Map(), "2026-07-04T12:00:11.000Z"),
      [toApiShoppingItem(eggs)]
    );

    expect(afterStaleResponse[0]).toMatchObject({ qty: 5, sync: { status: "dirty" } });
    expect(getSyncableDirtyItems(afterStaleResponse).map((item) => item.id)).toEqual(["eggs"]);
  });

  it("marks a pushed version synced when the server echoes it, and takes newer remote edits", () => {
    const pushed = buildItem({ id: "milk", qty: 1 });
    const echoed = applyRemoteShoppingItems(
      markShoppingItemsSynced([pushed], new Map([["milk", now]]), now),
      [toApiShoppingItem(pushed)]
    );

    expect(echoed[0]?.sync.status).toBe("synced");

    const failedLocal = buildItem({ id: "milk", qty: 1, sync: { status: "sync_failed" } });
    const newerRemote = {
      ...toApiShoppingItem(pushed),
      qty: 3,
      updatedAt: "2026-07-04T12:01:00.000Z"
    };

    expect(applyRemoteShoppingItems([failedLocal], [newerRemote])[0]).toMatchObject({
      qty: 3,
      sync: { status: "synced" }
    });
    expect(
      applyRemoteShoppingItems([failedLocal], [{ ...newerRemote, qty: 9, updatedAt: now }])[0]
    ).toMatchObject({ qty: 1, sync: { status: "sync_failed" } });
  });

  it("keeps merged item names within the household list's text limit", () => {
    // Parsing clips names to the limit; re-inflecting a clipped name for the new total used to
    // push it one character past it, and the household list rejected the whole sync batch.
    const line = `1 ${"very ".repeat(38)}ripe tomato`;
    const options = { canSync: true, now, userId: "user_1" };
    const once = addShoppingItemsToList([], [{ text: line }], options);
    const twice = addShoppingItemsToList(once, [{ text: line }], options);

    expect(once[0]?.text).toHaveLength(MAX_SHOPPING_ITEM_TEXT_LENGTH);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.qty).toBe(2);
    expect(twice[0]?.text.length).toBeLessThanOrEqual(MAX_SHOPPING_ITEM_TEXT_LENGTH);
    expect(shoppingItemSchema.safeParse(toApiShoppingItem(twice[0]!)).success).toBe(true);
  });

  it("clips over-long names stored by older app versions before pushing them", () => {
    const legacy = buildItem({ text: `${"very ".repeat(40)}ripe tomatoes` });
    const apiItem = toApiShoppingItem(legacy);

    expect(apiItem.text.length).toBeLessThanOrEqual(MAX_SHOPPING_ITEM_TEXT_LENGTH);
    expect(apiItem.text.startsWith("very very")).toBe(true);
    expect(shoppingItemSchema.safeParse(apiItem).success).toBe(true);
  });

  it("clips every text field the household list limits, not only the name", () => {
    const apiItem = toApiShoppingItem(
      buildItem({
        recipeId: `recipe_${"r".repeat(300)}`,
        recipeTitle: "Grandma's ".repeat(40),
        section: "For the frosting ".repeat(20),
        unit: "heaping tablespoon ".repeat(5)
      })
    );

    expect(apiItem.recipeId).toHaveLength(180);
    expect(apiItem.recipeTitle?.length).toBeLessThanOrEqual(200);
    expect(apiItem.recipeTitle?.startsWith("Grandma's Grandma's")).toBe(true);
    expect(apiItem.section?.length).toBeLessThanOrEqual(120);
    expect(apiItem.unit?.length).toBeLessThanOrEqual(40);
    expect(shoppingItemSchema.safeParse(apiItem).success).toBe(true);

    // Nothing left after trimming: the field is left out rather than sent empty.
    const blank = toApiShoppingItem(buildItem({ section: "   ", unit: "cup" }));
    expect(blank).not.toHaveProperty("section");
    expect(blank.unit).toBe("cup");
    expect(shoppingItemSchema.safeParse(blank).success).toBe(true);
  });

  it("marks check-off transitions dirty with the acting user", () => {
    const checked = setShoppingItemCheckedInList([buildItem()], "shopping_1", true, {
      canSync: true,
      now: "2026-07-04T12:03:00.000Z",
      userId: "user_2"
    });
    const unchecked = setShoppingItemCheckedInList(checked, "shopping_1", false, {
      canSync: true,
      now: "2026-07-04T12:04:00.000Z",
      userId: "user_2"
    });

    expect(checked[0]).toMatchObject({
      checked: true,
      checkedBy: "user_2",
      sync: { status: "dirty" },
      updatedAt: "2026-07-04T12:03:00.000Z"
    });
    expect(unchecked[0]).toMatchObject({
      checked: false,
      checkedBy: null,
      sync: { status: "dirty" },
      updatedAt: "2026-07-04T12:04:00.000Z"
    });
  });

  it("records the household an item belongs to without sending it", () => {
    const [eggs] = addShoppingItemsToList([], [{ text: "2 eggs" }], {
      canSync: true,
      householdId: "household_1",
      now,
      userId: "user_1"
    });
    expect(eggs?.sync).toEqual({ householdId: "household_1", status: "dirty" });
    expect(toApiShoppingItem(eggs!)).not.toHaveProperty("sync");
    expect(JSON.stringify(toApiShoppingItem(eggs!))).not.toContain("household_1");

    // Signed out, or signed in to another household: still household_1's item.
    const [checkedSignedOut] = setShoppingItemCheckedInList([eggs!], eggs!.id, true, {
      canSync: false
    });
    expect(checkedSignedOut?.sync).toEqual({ householdId: "household_1", status: "local_only" });
    const [checkedElsewhere] = setShoppingItemCheckedInList([eggs!], eggs!.id, true, {
      canSync: true,
      householdId: "household_2"
    });
    expect(checkedElsewhere?.sync).toEqual({ householdId: "household_1", status: "dirty" });
    const [mergedElsewhere] = addShoppingItemsToList([eggs!], [{ text: "1 egg" }], {
      canSync: true,
      householdId: "household_2"
    });
    expect(mergedElsewhere).toMatchObject({
      id: eggs!.id,
      qty: 3,
      sync: { householdId: "household_1", status: "dirty" }
    });
    const [deletedElsewhere] = deleteShoppingItemInList([eggs!], eggs!.id, {
      canSync: true,
      householdId: "household_2"
    });
    expect(deletedElsewhere?.sync).toEqual({ householdId: "household_1", status: "dirty" });
    expect(belongsToOtherHousehold(checkedElsewhere!, "household_2")).toBe(true);
    expect(belongsToOtherHousehold(checkedElsewhere!, "household_1")).toBe(false);

    // Items without a household (stored before it was recorded, or added signed out) join the
    // household the list syncs with; synced copies record the household they came from.
    const legacy = buildItem({ id: "legacy", sync: { status: "synced" } });
    expect(belongsToOtherHousehold(legacy, "household_2")).toBe(false);
    expect(
      setShoppingItemCheckedInList([legacy], "legacy", true, {
        canSync: true,
        householdId: "household_2"
      })[0]?.sync
    ).toEqual({ householdId: "household_2", status: "dirty" });
    expect(
      applyRemoteShoppingItems([], [toApiShoppingItem(legacy)], "household_2")[0]?.sync
    ).toEqual({ householdId: "household_2", lastSyncedAt: now, status: "synced" });
    expect(
      markShoppingItemsSynced([legacy], new Map([["legacy", now]]), now, "household_2")[0]?.sync
    ).toEqual({ householdId: "household_2", lastSyncedAt: now, status: "synced" });
  });

  it("sets another household's unsent changes aside as new local-only items", () => {
    const items = [
      buildItem({ id: "edited", sync: { householdId: "household_1", status: "sync_failed" } }),
      buildItem({
        deletedAt: now,
        id: "deleted",
        isDeleted: true,
        sync: { householdId: "household_1", status: "dirty" }
      }),
      buildItem({ id: "mine", sync: { householdId: "household_2", status: "dirty" } })
    ];

    const setAside = setAsideShoppingItems(items, new Set(["edited", "deleted"]), now);

    expect(setAside).toHaveLength(2);
    expect(setAside[0]).toEqual({
      ...items[0],
      id: setAside[0]?.id,
      sync: { status: "local_only" }
    });
    expect(setAside[0]?.id).not.toBe("edited");
    expect(setAside[1]).toBe(items[2]);
    expect(getSyncableDirtyItems(setAside).map((item) => item.id)).toEqual(["mine"]);
    expect(setAsideShoppingItems(items, new Set())).toBe(items);
  });

  it("reads the recorded household back, and older stored items without one", () => {
    const stored = [
      buildItem({ id: "a", sync: { householdId: "household_1", status: "synced" } }),
      buildItem({ id: "b", sync: { status: "dirty" } }),
      { ...buildItem({ id: "c" }), sync: { householdId: 42, status: "dirty" } }
    ];

    expect(parseShoppingItems(JSON.stringify(stored)).map((item) => item.sync)).toEqual([
      { householdId: "household_1", status: "synced" },
      { status: "dirty" },
      { status: "dirty" }
    ]);
  });

  it("builds add-from-recipe inputs with the active scale factor", () => {
    const inputs = recipeIngredientsToShoppingInputs(buildRecipe(), "recipe_1", {
      scaleFactor: 2,
      unitMode: "original"
    });

    expect(inputs).toEqual([
      {
        recipeId: "recipe_1",
        recipeTitle: "House Salad",
        section: "Dressing",
        text: "1 tsp salt"
      },
      {
        recipeId: "recipe_1",
        recipeTitle: "House Salad",
        section: "Dressing",
        text: "4 cups [560 g] flour"
      },
      {
        recipeId: "recipe_1",
        recipeTitle: "House Salad",
        section: "Finish",
        text: "Pepper to taste"
      }
    ]);
  });

  it("reports corrupt shopping blobs instead of reading them as an empty list", () => {
    const item = buildItem();

    expect(readShoppingItems(null)).toEqual({ items: [], status: "empty" });
    expect(readShoppingItems(serializeShoppingItems([item]))).toMatchObject({ status: "ok" });
    expect(readShoppingItems("[]")).toEqual({ items: [], status: "ok" });
    expect(readShoppingItems('[{"id":"a"')).toEqual({ items: [], status: "corrupt" });
    expect(readShoppingItems('{"items":[]}')).toEqual({ items: [], status: "corrupt" });
    expect(parseShoppingItems('[{"id":"a"')).toEqual([]);
  });
});
