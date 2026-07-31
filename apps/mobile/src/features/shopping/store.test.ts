import { describe, expect, it } from "vitest";

import {
  addShoppingItemsToList,
  parseShoppingItems,
  recipeIngredientsToShoppingInputs,
  serializeShoppingItems,
  setShoppingItemCheckedInList,
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

  it("merges identical item text only when units match", () => {
    const base = addShoppingItemsToList(
      [],
      [{ text: "1 cup sugar" }],
      { canSync: false, now, userId: "user_1" }
    );
    const merged = addShoppingItemsToList(
      base,
      [{ text: "2 cups sugar" }],
      { canSync: false, now: "2026-07-04T12:01:00.000Z", userId: "user_1" }
    );
    const separateUnit = addShoppingItemsToList(
      merged,
      [{ text: "1 tbsp sugar" }],
      { canSync: false, now: "2026-07-04T12:02:00.000Z", userId: "user_1" }
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      qty: 3,
      text: "sugar",
      unit: "cup"
    });
    expect(separateUnit).toHaveLength(2);
    expect(separateUnit.map((item) => item.unit?.toLowerCase()).sort()).toEqual(["cup", "tbsp"]);
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
});
