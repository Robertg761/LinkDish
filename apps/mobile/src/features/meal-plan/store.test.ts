import { addDaysToIsoDate, SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  buildPlanShopping,
  compareMealPlanEntries,
  createMealPlanEntry,
  defaultServingsFor,
  formatWeekRange,
  getDayLabel,
  getWeekTitle,
  isValidIsoDate,
  MealPlanValidationError,
  noteIconFor,
  parseMealPlan,
  rankRecipesForPlanning,
  suggestSlot,
  toShoppingListInput,
  updateMealPlanEntryRecord,
  type MealPlanEntry
} from "./store";

import type { SavedRecipeRecord } from "../saved-recipes/store";
import type { Recipe } from "@linkdish/recipe-domain";

const now = new Date("2026-10-26T12:00:00.000Z");

const recipe = (title: string, overrides: Partial<Recipe> = {}): Recipe => ({
  ...SAMPLE_RECIPES[0].recipe,
  ingredients: [{ text: "2 onions" }, { text: "1 cup rice" }],
  servings: "4 servings",
  sourceUrl: `https://example.com/${encodeURIComponent(title)}`,
  title,
  ...overrides
});

const record = (
  id: string,
  title: string,
  overrides: Partial<SavedRecipeRecord> = {}
): SavedRecipeRecord => ({
  fetchMode: "http",
  id,
  provenance: ["jsonld"],
  recipe: recipe(title),
  savedAt: "2026-10-01T12:00:00.000Z",
  strategy: "recipe-schema",
  warnings: [],
  ...overrides
});

const entry = (overrides: Partial<MealPlanEntry>): MealPlanEntry => ({
  createdAt: "2026-10-26T12:00:00.000Z",
  date: "2026-10-26",
  id: "plan-1",
  slot: "dinner",
  title: "Soup",
  updatedAt: "2026-10-26T12:00:00.000Z",
  ...overrides
});

describe("meal plan entries", () => {
  it("creates an entry with a cleaned-up title and only the details it has", () => {
    const created = createMealPlanEntry(
      {
        date: "2026-10-27",
        note: "  ",
        recipeId: " saved-1 ",
        servings: 2.555,
        slot: "lunch",
        title: "  Big   soup "
      },
      now
    );

    expect(created).toMatchObject({
      date: "2026-10-27",
      recipeId: "saved-1",
      servings: 2.56,
      slot: "lunch",
      title: "Big soup"
    });
    expect(created).not.toHaveProperty("note");
    expect(created.createdAt).toBe(now.toISOString());
  });

  it("refuses a bad day, meal or title", () => {
    expect(() =>
      createMealPlanEntry({ date: "2026-02-30", slot: "dinner", title: "Soup" })
    ).toThrow(MealPlanValidationError);
    expect(() =>
      createMealPlanEntry({ date: "2026-10-27", slot: "brunch" as "lunch", title: "Soup" })
    ).toThrow("Pick breakfast, lunch, dinner or a snack.");
    expect(() => createMealPlanEntry({ date: "2026-10-27", slot: "dinner", title: " " })).toThrow(
      "Give this meal a name."
    );
  });

  it("changes only the fields asked for, and null clears an optional one", () => {
    const original = entry({ note: "Double it", recipeId: "saved-1", servings: 4 });
    const later = new Date("2026-10-27T08:00:00.000Z");
    const updated = updateMealPlanEntryRecord(
      original,
      { date: "2026-10-28", note: null, servings: 6 },
      later
    );

    expect(updated).toEqual({
      ...original,
      date: "2026-10-28",
      note: undefined,
      servings: 6,
      updatedAt: later.toISOString()
    });
    expect(updated).not.toHaveProperty("note");
  });

  it("orders entries by day, then meal, then when they were added", () => {
    const sorted = [
      entry({ date: "2026-10-27", id: "c", slot: "breakfast" }),
      entry({ date: "2026-10-26", id: "b", slot: "dinner" }),
      entry({ date: "2026-10-26", id: "a", slot: "lunch" })
    ].sort(compareMealPlanEntries);

    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("reads a stored plan, leaving out anything unreadable", () => {
    const stored = JSON.stringify([
      entry({ date: "2026-10-27", id: "kept", servings: 2 }),
      { ...entry({ id: "bad-slot" }), slot: "brunch" },
      { ...entry({ id: "bad-date" }), date: "Monday" },
      null
    ]);

    expect(parseMealPlan(stored).map((item) => item.id)).toEqual(["kept"]);
    expect(parseMealPlan("not json")).toEqual([]);
    expect(parseMealPlan(null)).toEqual([]);
  });
});

describe("plan labels", () => {
  it("names days and weeks", () => {
    expect(getDayLabel("2026-10-26")).toEqual({
      dayOfMonth: "26",
      monthDay: "Oct 26",
      weekday: "Mon",
      weekdayLong: "Monday"
    });
    expect(formatWeekRange(["2026-10-25", "2026-10-26", "2026-10-31"])).toBe("Oct 25 – Oct 31");
    expect(getWeekTitle("2026-10-25", "2026-10-25", addDaysToIsoDate)).toBe("This week");
    expect(getWeekTitle("2026-11-01", "2026-10-25", addDaysToIsoDate)).toBe("Next week");
    expect(getWeekTitle("2026-10-18", "2026-10-25", addDaysToIsoDate)).toBe("Last week");
    expect(getWeekTitle("2026-11-08", "2026-10-25", addDaysToIsoDate)).toBe("Week of Nov 8");
  });

  it("checks calendar dates and picks note icons", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("26-10-2026")).toBe(false);
    expect(noteIconFor("Leftovers from Sunday")).toBe("pot-steam-outline");
    expect(noteIconFor("Pizza delivery")).toBe("shopping-outline");
    expect(noteIconFor("Grandma's")).toBe("note-text-outline");
  });
});

describe("planning recipes", () => {
  it("suggests dinner first, then the next free meal", () => {
    expect(suggestSlot([])).toBe("dinner");
    expect(suggestSlot([{ slot: "dinner" }])).toBe("lunch");
    expect(suggestSlot([{ slot: "dinner" }, { slot: "lunch" }])).toBe("breakfast");
  });

  it("puts what suits the meal first, then favorites and often cooked", () => {
    const pancakes = record("p", "Buttermilk pancakes", {
      recipe: recipe("Buttermilk pancakes"),
      libraryExtras: { tags: ["Breakfast"] }
    });
    const stew = record("s", "Beef stew", { libraryExtras: { tags: ["Dinner"] } });
    const salad = record("a", "Family favorite", { favorite: true });
    const soup = record("o", "Onion soup", { timesCooked: 3 });

    expect(
      rankRecipesForPlanning([pancakes, soup, salad, stew], "dinner").map((item) => item.id)
    ).toEqual(["s", "a", "o", "p"]);
    expect(rankRecipesForPlanning([stew, pancakes], "breakfast")[0]?.id).toBe("p");
  });

  it("uses the recipe's yield for servings", () => {
    expect(defaultServingsFor(record("a", "Soup"))).toBe(4);
    expect(defaultServingsFor(undefined)).toBeUndefined();
  });
});

describe("shopping for the week", () => {
  it("scales each meal to its servings, merges the list and skips meals without a recipe", () => {
    const soup = record("soup", "Onion soup");
    const pilaf = record("pilaf", "Pilaf", {
      recipe: recipe("Pilaf", {
        ingredients: [{ text: "1 onion" }],
        servings: "2"
      })
    });
    const shopping = buildPlanShopping(
      [
        entry({ id: "1", recipeId: "soup", servings: 2, title: "Onion soup" }),
        entry({ id: "2", recipeId: "pilaf", title: "Pilaf" }),
        entry({ id: "3", title: "Leftovers" }),
        entry({ id: "4", recipeId: "deleted", title: "Gone" })
      ],
      new Map([
        ["soup", soup],
        ["pilaf", pilaf]
      ])
    );

    expect(shopping).toMatchObject({ mealCount: 2, recipeCount: 2, skippedCount: 2 });
    const onions = shopping.items.find((item) => item.text.includes("onion"));
    expect(onions).toMatchObject({ qty: 2, recipeIds: ["soup", "pilaf"] });
    expect(shopping.items.find((item) => item.text.includes("rice"))).toMatchObject({
      qty: 0.5,
      unit: "cup"
    });
    expect(toShoppingListInput(onions!)).toEqual({
      recipeId: "soup",
      recipeTitle: "Onion soup",
      text: "2 onions"
    });
  });
});
