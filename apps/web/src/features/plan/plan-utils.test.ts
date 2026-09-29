import { describe, expect, it } from "vitest";

import {
  defaultServingsFor,
  findOpenDinnerDates,
  getWeekDates,
  getWeekTitle,
  noteIconFor,
  rankRecipesForPlanning,
  relativeDayName,
  suggestSlot,
  weekStartFor
} from "./plan-utils";
import { makeSavedRecipe } from "./testing/plan-fixtures";

describe("plan-utils", () => {
  it("starts weeks on Sunday or Monday", () => {
    // 2026-09-30 is a Wednesday.
    expect(weekStartFor("2026-09-30", 1)).toBe("2026-09-28");
    expect(weekStartFor("2026-09-30", 0)).toBe("2026-09-27");
    expect(weekStartFor("2026-09-27", 1)).toBe("2026-09-21");
    expect(getWeekDates("2026-09-28")).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04"
    ]);
  });

  it("names weeks relative to this one", () => {
    expect(getWeekTitle("2026-09-28", "2026-09-28")).toEqual({ accent: "week", title: "This" });
    expect(getWeekTitle("2026-10-05", "2026-09-28")).toEqual({ accent: "week", title: "Next" });
    expect(getWeekTitle("2026-09-21", "2026-09-28")).toEqual({ accent: "week", title: "Last" });
    expect(getWeekTitle("2026-10-12", "2026-09-28").title).toBe("Week of");
  });

  it("finds the next free dinners from a day on", () => {
    const dates = getWeekDates("2026-09-28");
    const entries = [
      { date: "2026-09-29", slot: "dinner" as const },
      { date: "2026-09-30", slot: "lunch" as const }
    ];

    expect(findOpenDinnerDates(dates, entries, "2026-09-29")).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04"
    ]);
  });

  it("suggests the meal slot that is still free", () => {
    expect(suggestSlot([])).toBe("dinner");
    expect(suggestSlot([{ slot: "dinner" }])).toBe("lunch");
    expect(suggestSlot([{ slot: "dinner" }, { slot: "lunch" }])).toBe("breakfast");
  });

  it("puts favorites and often-cooked recipes first", () => {
    const ranked = rankRecipesForPlanning([
      makeSavedRecipe("a", "Apple Cake"),
      makeSavedRecipe("b", "Bean Chili", { timesCooked: 6 }),
      makeSavedRecipe("c", "Carrot Soup", { favorite: true })
    ]);

    expect(ranked.map((recipe) => recipe.id)).toEqual(["c", "b", "a"]);
  });

  it("reads default servings from the cook's preference or the recipe", () => {
    expect(defaultServingsFor(makeSavedRecipe("a", "A", { servings: "Serves 6" }))).toBe(6);
    expect(
      defaultServingsFor(makeSavedRecipe("a", "A", { preferredServings: 3, servings: "6" }))
    ).toBe(3);
    expect(defaultServingsFor(undefined)).toBeUndefined();
  });

  it("labels days and notes in plain words", () => {
    expect(relativeDayName("2026-09-30", "2026-09-30")).toBe("today");
    expect(relativeDayName("2026-10-01", "2026-09-30")).toBe("tomorrow");
    expect(noteIconFor("Leftovers")).toBe("cooking-pot");
    expect(noteIconFor("Eat out")).toBe("utensils");
    expect(noteIconFor("Grandma's")).toBe("sticky-note");
  });
});
