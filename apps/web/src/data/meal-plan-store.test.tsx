import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  resetLinkDishWebDbForTests
} from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";
import { holdNextWrite } from "../storage/testing/held-write";

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
  compareMealPlanEntries,
  getMealPlanEntriesInRange,
  getMealPlanSnapshot,
  loadMealPlan,
  MealPlanValidationError,
  moveMealPlanEntry,
  moveMealPlanEntryOptimistic,
  removeMealPlanEntry,
  removeMealPlanEntryOptimistic,
  resetMealPlanStoreForTests,
  updateMealPlanEntry,
  useMealPlanRange
} from "./meal-plan-store";

import type { MealPlanEntry } from "./meal-plan-store";

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

describe("optimistic meal-plan changes", () => {
  const describeEntries = (entries: readonly MealPlanEntry[]) =>
    entries.map((entry) => `${entry.title} ${entry.date} ${entry.slot}`);
  const shown = () => describeEntries(getMealPlanSnapshot().data);
  const stored = () =>
    describeEntries(
      fakeIdb.records<MealPlanEntry>(MEAL_PLAN_STORE_NAME).sort(compareMealPlanEntries)
    );
  const plan = (date: string, title: string) => addMealPlanEntry({ date, slot: "dinner", title });

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

  it("rolls back only the failed removal, keeping changes saved meanwhile", async () => {
    const soup = await plan("2026-09-28", "Soup");
    const tacos = await plan("2026-09-29", "Tacos");
    const curry = await plan("2026-09-30", "Curry");
    await loadMealPlan();
    const held = holdNextWrite(await getLinkDishWebDb(), "delete");

    const removing = removeMealPlanEntryOptimistic(soup.id);
    await held.started;
    expect(shown()).toEqual(["Tacos 2026-09-29 dinner", "Curry 2026-09-30 dinner"]);

    // While that delete is pending, other changes are saved (and shown).
    await removeMealPlanEntryOptimistic(tacos.id);
    await moveMealPlanEntryOptimistic(curry.id, { date: "2026-10-01", slot: "lunch" });
    held.fail(new Error("disk full"));
    await expect(removing).rejects.toThrow("disk full");

    expect(shown()).toEqual(["Soup 2026-09-28 dinner", "Curry 2026-10-01 lunch"]);
    expect(stored()).toEqual(shown());
  });

  it("rolls back only the failed move, keeping changes saved meanwhile", async () => {
    const soup = await plan("2026-09-28", "Soup");
    const tacos = await plan("2026-09-29", "Tacos");
    await loadMealPlan();
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const moving = moveMealPlanEntryOptimistic(soup.id, { date: "2026-10-02" });
    await held.started;
    expect(shown()).toEqual(["Tacos 2026-09-29 dinner", "Soup 2026-10-02 dinner"]);

    await removeMealPlanEntryOptimistic(tacos.id);
    await plan("2026-09-30", "Pie");
    held.fail(new Error("disk full"));
    await expect(moving).rejects.toThrow("disk full");

    expect(shown()).toEqual(["Soup 2026-09-28 dinner", "Pie 2026-09-30 dinner"]);
    expect(stored()).toEqual(shown());
  });

  it("keeps a newer change to the entry, and settles on storage once that fails too", async () => {
    const soup = await plan("2026-09-28", "Soup");
    await loadMealPlan();
    const db = await getLinkDishWebDb();

    const firstHeld = holdNextWrite(db, "transaction");
    const firstMove = moveMealPlanEntryOptimistic(soup.id, { date: "2026-09-29" });
    await firstHeld.started;
    const secondHeld = holdNextWrite(db, "transaction");
    const secondMove = moveMealPlanEntryOptimistic(soup.id, { date: "2026-09-30" });
    await secondHeld.started;

    firstHeld.fail(new Error("disk full"));
    await expect(firstMove).rejects.toThrow("disk full");
    expect(shown()).toEqual(["Soup 2026-09-30 dinner"]);

    // The second move's rollback would show the first move, which never saved either.
    secondHeld.fail(new Error("disk full"));
    await expect(secondMove).rejects.toThrow("disk full");
    await waitFor(() => expect(shown()).toEqual(["Soup 2026-09-28 dinner"]));
    expect(stored()).toEqual(shown());
  });

  it("does not bring back an entry deleted while its failed removal was pending", async () => {
    const soup = await plan("2026-09-28", "Soup");
    await plan("2026-09-29", "Tacos");
    await loadMealPlan();
    const held = holdNextWrite(await getLinkDishWebDb(), "delete");

    const removing = removeMealPlanEntryOptimistic(soup.id);
    await held.started;
    await removeMealPlanEntry(soup.id);
    held.fail(new Error("disk full"));
    await expect(removing).rejects.toThrow("disk full");

    await waitFor(() => expect(shown()).toEqual(["Tacos 2026-09-29 dinner"]));
    expect(stored()).toEqual(shown());
  });
});
