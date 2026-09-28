import { beforeEach, describe, expect, it } from "vitest";

import {
  ADDED_BY_YOU_GROUP_ID,
  buildShoppingShareText,
  formatItemAmount,
  formatSyncedAgo,
  getShoppingSuggestions,
  groupItemsByAisle,
  groupItemsByRecipe,
  openItemKeys,
  readHideStaples,
  recordShoppingHistory,
  writeHideStaples
} from "./shopping-format";

import type { WebShoppingItem } from "./shopping-list-store";

let counter = 0;
const item = (overrides: Partial<WebShoppingItem>): WebShoppingItem => {
  counter += 1;
  return {
    addedBy: "local",
    checked: false,
    checkedBy: null,
    createdAt: `2026-09-28T10:00:${String(counter).padStart(2, "0")}.000Z`,
    id: `item-${counter}`,
    sync: { status: "local_only" },
    text: "thing",
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides
  };
};

describe("shopping-format", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("groups by aisle in store-walk order, keeping list order inside an aisle", () => {
    const groups = groupItemsByAisle([
      item({ qty: 2, text: "flour", unit: "cup" }),
      item({ qty: 1, text: "onion" }),
      item({ text: "whole milk" }),
      item({ qty: 1, text: "chicken thighs", unit: "lb" }),
      item({ qty: 2, text: "garlic", unit: "clove" }),
      item({ qty: 1, text: "chickpeas (15 ounce)", unit: "can" })
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Produce",
      "Meat & Seafood",
      "Dairy & Eggs",
      "Baking",
      "Canned & Jarred"
    ]);
    expect(groups[0]?.items.map((entry) => entry.text)).toEqual(["onion", "garlic"]);
  });

  it("groups under every recipe an item is for and puts hand-added items last", () => {
    const groups = groupItemsByRecipe([
      item({ text: "paper towels" }),
      item({ recipeId: "a", recipeTitle: "Chili", text: "beans" }),
      item({ recipeIds: ["b", "a"], recipeTitles: ["Tacos", "Chili"], text: "onion" }),
      item({ recipeId: "a", recipeTitle: "Chili", text: "cumin" })
    ]);

    // The onion is for both, so it shows under Tacos and under Chili.
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([
      ["Chili", 3],
      ["Tacos", 1],
      ["Added by you", 1]
    ]);
    expect(groups[2]?.id).toBe(ADDED_BY_YOU_GROUP_ID);
  });

  it("shares what is left to buy as plain text grouped by aisle", () => {
    const text = buildShoppingShareText([
      item({ qty: 2 / 3, text: "brown sugar", unit: "cup" }),
      item({ qty: 2, text: "onions" }),
      item({ checked: true, text: "eggs" }),
      item({ text: "paper towels" })
    ]);

    expect(text).toBe(
      "Shopping list\n\nProduce\n• 2 onions\n\nBaking\n• ⅔ cup brown sugar\n\nOther\n• paper towels\n"
    );
    expect(buildShoppingShareText([item({ checked: true })])).toContain("Nothing left to buy");
  });

  it("formats just the amount of an item", () => {
    expect(formatItemAmount(item({ qty: { max: 2, min: 1 }, text: "limes" }))).toBe("1–2");
    expect(formatItemAmount(item({ qty: 1.5, text: "flour", unit: "cup" }))).toBe("1 ½ cups");
    expect(formatItemAmount(item({ text: "salt" }))).toBe("");
  });

  it("suggests past items first, then everyday staples, minus what is on the list", () => {
    const now = Date.UTC(2026, 8, 28);
    recordShoppingHistory(["oat milk", "Oat milk", "coffee beans"], now);

    const suggestions = getShoppingSuggestions("", { now });
    expect(suggestions.slice(0, 2)).toEqual(["Oat milk", "Coffee beans"]);
    expect(suggestions).toContain("Eggs");

    const onList = openItemKeys([item({ text: "coffee beans" }), item({ text: "eggs" })]);
    const filtered = getShoppingSuggestions("", { exclude: onList, now });
    expect(filtered).not.toContain("Coffee beans");
    expect(filtered).not.toContain("Eggs");

    expect(getShoppingSuggestions("oat", { now })).toEqual(["Oat milk"]);
    expect(getShoppingSuggestions("oat milk", { now })).toEqual([]);
  });

  it("remembers whether pantry staples are hidden", () => {
    expect(readHideStaples()).toBe(false);
    writeHideStaples(true);
    expect(readHideStaples()).toBe(true);
  });

  it("says how long ago the list synced", () => {
    const now = Date.UTC(2026, 8, 28, 12, 0, 0);
    expect(formatSyncedAgo(now - 20_000, now)).toBe("just now");
    expect(formatSyncedAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatSyncedAgo(now - 3 * 3_600_000, now)).toMatch(/^at /u);
  });
});
