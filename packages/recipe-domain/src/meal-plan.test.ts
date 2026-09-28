import { describe, expect, it } from "vitest";

import {
  addDaysToIsoDate,
  buildShoppingInputsForPlan,
  formatShoppingItemText,
  groupEntriesByDay,
  isoDayOfWeek,
  mealPlanEntrySchema,
  mergeShoppingInputs,
  SAMPLE_RECIPES,
  startOfWeek,
  toIsoDate,
  weekDays
} from "./index.js";

import type { MealPlanEntry, Recipe } from "./index.js";

describe("calendar dates", () => {
  it("formats dates as local calendar days", () => {
    expect(toIsoDate("2026-09-27")).toBe("2026-09-27");
    expect(toIsoDate(new Date(2026, 8, 27, 23, 59))).toBe("2026-09-27");
    expect(toIsoDate(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
    expect(() => toIsoDate("not a date")).toThrow(RangeError);
    expect(() => toIsoDate("2026-13-45")).toThrow(RangeError);
  });

  it("adds days across months, years and leap days", () => {
    expect(addDaysToIsoDate("2026-09-27", 7)).toBe("2026-10-04");
    expect(addDaysToIsoDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToIsoDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToIsoDate("2026-03-08", -1)).toBe("2026-03-07");
  });

  it("finds the start of the week for Sunday and Monday weeks", () => {
    // 2026-09-27 is a Sunday.
    expect(isoDayOfWeek("2026-09-27")).toBe(0);
    expect(startOfWeek("2026-09-27")).toBe("2026-09-27");
    expect(startOfWeek("2026-09-27", 1)).toBe("2026-09-21");
    expect(startOfWeek("2026-10-01")).toBe("2026-09-27");
    expect(startOfWeek("2026-10-01", 1)).toBe("2026-09-28");
    expect(startOfWeek("2027-01-01", 1)).toBe("2026-12-28");
  });

  it("lists the days of a week", () => {
    expect(weekDays("2026-09-27")).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03"
    ]);
  });
});

describe("mealPlanEntrySchema", () => {
  it("accepts recipe and free-text entries and rejects impossible dates", () => {
    expect(
      mealPlanEntrySchema.safeParse({
        id: "e1",
        date: "2026-09-28",
        slot: "dinner",
        recipeId: "starter-ginger-sesame-chicken-rice-skillet",
        servings: 6,
        updatedAt: "2026-09-27T12:00:00.000Z"
      }).success
    ).toBe(true);
    expect(
      mealPlanEntrySchema.safeParse({ id: "e2", date: "2026-09-28", title: "Leftovers" }).success
    ).toBe(true);
    expect(mealPlanEntrySchema.safeParse({ id: "e3", date: "2026-02-30" }).success).toBe(false);
    expect(
      mealPlanEntrySchema.safeParse({ id: "e4", date: "2026-09-28", slot: "brunch" }).success
    ).toBe(false);
    expect(
      mealPlanEntrySchema.safeParse({ id: "e5", date: "2026-09-28", servings: 0 }).success
    ).toBe(false);
  });
});

describe("groupEntriesByDay", () => {
  const entries: MealPlanEntry[] = [
    { id: "a", date: "2026-09-29", slot: "dinner" },
    { id: "b", date: "2026-09-28", title: "Leftovers" },
    { id: "c", date: "2026-09-28", slot: "breakfast" },
    { id: "d", date: "2026-09-28", slot: "dinner" },
    { id: "e", date: "2026-10-10", slot: "lunch" }
  ];

  it("groups by date with meals in slot order", () => {
    expect(
      groupEntriesByDay(entries).map((day) => [day.date, day.entries.map((entry) => entry.id)])
    ).toEqual([
      ["2026-09-28", ["c", "d", "b"]],
      ["2026-09-29", ["a"]],
      ["2026-10-10", ["e"]]
    ]);
  });

  it("returns every requested day, including empty ones", () => {
    const week = groupEntriesByDay(entries, weekDays("2026-09-27"));

    expect(week).toHaveLength(7);
    expect(week.map((day) => day.entries.length)).toEqual([0, 3, 1, 0, 0, 0, 0]);
  });
});

describe("buildShoppingInputsForPlan", () => {
  const skillet = SAMPLE_RECIPES[0];
  const pitas = SAMPLE_RECIPES[2];
  const recipesById = new Map<string, Recipe>([
    [skillet.id, skillet.recipe],
    [pitas.id, pitas.recipe]
  ]);

  it("scales each planned recipe to the entry's servings", () => {
    const inputs = buildShoppingInputsForPlan(
      [
        { date: "2026-09-28", recipeId: skillet.id, servings: 8 },
        { date: "2026-09-29", recipeId: pitas.id },
        { date: "2026-09-30", recipeId: "missing" },
        { date: "2026-09-30", recipeId: null }
      ],
      recipesById
    );

    expect(inputs).toHaveLength(
      skillet.recipe.ingredients.length + pitas.recipe.ingredients.length
    );
    expect(inputs[0]).toEqual({
      recipeId: skillet.id,
      recipeTitle: "Ginger-Sesame Chicken Rice Skillet",
      section: "For the sauce",
      text: "6 Tbsp low-sodium soy sauce"
    });
    expect(inputs.find((input) => input.recipeId === pitas.id)?.text).toBe(
      "1 can chickpeas, drained and rinsed"
    );
  });

  it("filters by date, accepts a plain record and merges into one list", () => {
    const inputs = buildShoppingInputsForPlan(
      [
        { date: "2026-09-28", recipeId: skillet.id, servings: 4 },
        { date: "2026-09-29", recipeId: skillet.id, servings: 4 },
        { date: "2026-10-05", recipeId: skillet.id, servings: 4 }
      ],
      { [skillet.id]: skillet.recipe },
      { dates: weekDays("2026-09-27"), units: "metric" }
    );
    const merged = mergeShoppingInputs(inputs);

    expect(inputs).toHaveLength(skillet.recipe.ingredients.length * 2);
    expect(merged).toHaveLength(skillet.recipe.ingredients.length);
    expect(merged.map(formatShoppingItemText)).toContain("900 g boneless skinless chicken thighs");
  });

  it("skips a recipe id named like an Object.prototype member in a plain record (fuzz)", () => {
    const entries = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"].map(
      (recipeId) => ({ date: "2026-09-27", recipeId })
    );

    expect(buildShoppingInputsForPlan(entries, {})).toEqual([]);
    expect(
      buildShoppingInputsForPlan([...entries, { date: "2026-09-27", recipeId: pitas.id }], {
        [pitas.id]: pitas.recipe
      })
    ).toHaveLength(pitas.recipe.ingredients.length);
  });
});
