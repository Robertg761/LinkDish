import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLinkDishWebDbForTests } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  addDaysToDateKey,
  getDateKeyRange,
  getWeekStartDateKey,
  isDateKey,
  toDateKey
} from "./date-keys";
import {
  addMealPlanEntry,
  getMealPlanEntriesInRange,
  MealPlanValidationError,
  moveMealPlanEntry,
  moveMealPlanEntryOptimistic,
  removeMealPlanEntry,
  resetMealPlanStoreForTests,
  updateMealPlanEntry,
  useMealPlanRange
} from "./meal-plan-store";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

describe("date keys", () => {
  it("validates and formats calendar days", () => {
    expect(isDateKey("2026-02-28")).toBe(true);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-2-3")).toBe(false);
    expect(toDateKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("does day arithmetic across months, years and DST", () => {
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDateKey("2026-03-07", 2)).toBe("2026-03-09");
    expect(getDateKeyRange("2026-10-31", 3)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(() => addDaysToDateKey("soon", 1)).toThrow(RangeError);
  });

  it("finds the start of the week", () => {
    // 2026-09-27 is a Sunday.
    expect(getWeekStartDateKey("2026-09-27")).toBe("2026-09-21");
    expect(getWeekStartDateKey("2026-09-27", 0)).toBe("2026-09-27");
    expect(getWeekStartDateKey("2026-09-21")).toBe("2026-09-21");
  });
});

describe("meal-plan-store", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetMealPlanStoreForTests();
    setDataChannelFactoryForTests(() => null);
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds, edits, moves and removes entries", async () => {
    const entry = await addMealPlanEntry({
      date: "2026-09-28",
      note: "  double batch ",
      recipeId: "recipe-1",
      servings: 4,
      slot: "dinner",
      title: " Lemony   pasta "
    });

    expect(entry).toMatchObject({
      date: "2026-09-28",
      note: "double batch",
      recipeId: "recipe-1",
      servings: 4,
      slot: "dinner",
      title: "Lemony pasta"
    });

    const edited = await updateMealPlanEntry(entry.id, { note: null, recipeId: null, servings: 2 });
    expect(edited).not.toHaveProperty("note");
    expect(edited).not.toHaveProperty("recipeId");
    expect(edited?.servings).toBe(2);

    const moved = await moveMealPlanEntry(entry.id, { date: "2026-09-30", slot: "lunch" });
    expect(moved).toMatchObject({ date: "2026-09-30", slot: "lunch" });

    await removeMealPlanEntry(entry.id);
    expect(await getMealPlanEntriesInRange("2026-09-28", 7)).toEqual([]);
    expect(await updateMealPlanEntry("missing", { title: "x" })).toBeUndefined();
  });

  it("rejects invalid days, slots and titles", async () => {
    await expect(
      addMealPlanEntry({ date: "2026-13-01", slot: "dinner", title: "Soup" })
    ).rejects.toBeInstanceOf(MealPlanValidationError);
    await expect(
      addMealPlanEntry({ date: "2026-09-28", slot: "brunch" as never, title: "Soup" })
    ).rejects.toBeInstanceOf(MealPlanValidationError);
    await expect(
      addMealPlanEntry({ date: "2026-09-28", slot: "dinner", title: "   " })
    ).rejects.toBeInstanceOf(MealPlanValidationError);
  });

  it("serves a week grouped by day and slot, including empty days", async () => {
    await addMealPlanEntry({ date: "2026-09-29", slot: "dinner", title: "Tacos" });
    await addMealPlanEntry({ date: "2026-09-29", slot: "breakfast", title: "Oats" });
    await addMealPlanEntry({ date: "2026-10-10", slot: "lunch", title: "Out of range" });

    const { result } = renderHook(() => useMealPlanRange("2026-09-28", 7));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.days).toHaveLength(7);
    expect(result.current.days[0]).toEqual({ date: "2026-09-28", entries: [] });
    expect(result.current.days[1]?.entries.map((entry) => entry.title)).toEqual(["Oats", "Tacos"]);
    expect(result.current.entries).toHaveLength(2);

    await act(async () => {
      await addMealPlanEntry({ date: "2026-10-04", slot: "snack", title: "Popcorn" });
    });
    expect(result.current.days[6]?.entries.map((entry) => entry.title)).toEqual(["Popcorn"]);

    const tacos = result.current.days[1]!.entries[1]!;
    await act(async () => {
      await moveMealPlanEntryOptimistic(tacos.id, { date: "2026-09-30" });
    });
    expect(result.current.days[2]?.entries.map((entry) => entry.title)).toEqual(["Tacos"]);
  });

  it("returns an empty range for an invalid start", async () => {
    const { result } = renderHook(() => useMealPlanRange("next week", 7));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.days).toEqual([]);
  });
});
