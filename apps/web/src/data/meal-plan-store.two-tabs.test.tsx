import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getLinkDishWebDb,
  MEAL_PLAN_STORE_NAME,
  resetLinkDishWebDbForTests
} from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../storage/testing/fake-idb-isolation";
import { holdNextWrite } from "../storage/testing/held-write";
import { createChannelPair } from "../storage/testing/two-tabs";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  addMealPlanEntry,
  getMealPlanSnapshot,
  loadMealPlan,
  moveMealPlanEntry,
  removeMealPlanEntryOptimistic,
  resetMealPlanStoreForTests,
  updateMealPlanEntry,
  useMealPlanRange
} from "./meal-plan-store";

import type { MealPlanEntry } from "./meal-plan-store";

vi.mock(
  "idb",
  async () => (await import("../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);

/** Another tab on the same database: fresh copies of the connection, change feed and cache. */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("./change-feed");
  const store = await import("./meal-plan-store");
  await (await import("../storage/linkdish-db")).getLinkDishWebDb();
  return { feed, store };
};

const storedEntry = (id: string) => fakeIdb.record<MealPlanEntry>(MEAL_PLAN_STORE_NAME, id);

describe("meal-plan writes from two tabs", () => {
  let entry: MealPlanEntry;

  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetMealPlanStoreForTests();
    setDataChannelFactoryForTests(() => null);
    entry = await addMealPlanEntry({
      date: "2026-09-28",
      recipeId: "recipe-1",
      servings: 2,
      slot: "dinner",
      title: "Lemony pasta"
    });
  });

  afterEach(() => {
    setDataChannelFactoryForTests(() => null);
    vi.restoreAllMocks();
  });

  it("keeps a note added in one tab while the other moves the meal", async () => {
    const other = await openOtherTab();
    const [here, there] = createChannelPair();
    setDataChannelFactoryForTests(() => here);
    other.feed.setDataChannelFactoryForTests(() => there);
    const hereView = renderHook(() => useMealPlanRange("2026-09-28", 7));
    const thereView = renderHook(() => other.store.useMealPlanRange("2026-09-28", 7));
    await waitFor(() => {
      expect(hereView.result.current.entries).toHaveLength(1);
      expect(thereView.result.current.entries).toHaveLength(1);
    });

    await act(async () => {
      await Promise.all([
        updateMealPlanEntry(entry.id, { note: "Double the garlic" }),
        other.store.moveMealPlanEntry(entry.id, { date: "2026-09-30", slot: "lunch" })
      ]);
    });

    const both = { date: "2026-09-30", note: "Double the garlic", servings: 2, slot: "lunch" };
    expect(storedEntry(entry.id)).toMatchObject(both);

    // Each tab shows both changes: its own write, then the other tab's announced one.
    await waitFor(() => {
      expect(hereView.result.current.entries).toEqual([expect.objectContaining(both)]);
      expect(thereView.result.current.entries).toEqual([expect.objectContaining(both)]);
    });
  });

  it("keeps a servings change from one tab and a new title from the other", async () => {
    const other = await openOtherTab();

    await Promise.all([
      other.store.updateMealPlanEntry(entry.id, { servings: 6 }),
      updateMealPlanEntry(entry.id, { title: "Lemony pasta (big pot)" })
    ]);

    expect(storedEntry(entry.id)).toMatchObject({
      date: "2026-09-28",
      recipeId: "recipe-1",
      servings: 6,
      title: "Lemony pasta (big pot)"
    });
  });

  it("does not bring back an entry the other tab removed", async () => {
    const other = await openOtherTab();

    await Promise.all([
      moveMealPlanEntry(entry.id, { date: "2026-10-01" }),
      other.store.removeMealPlanEntry(entry.id)
    ]);

    // Whichever landed first, the removal wins: a move never recreates a deleted entry.
    expect(storedEntry(entry.id)).toBeUndefined();
  });

  it("keeps the other tab's removal when a removal here fails", async () => {
    // The test setup's `randomUUID` always answers the same id.
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const tacos = await addMealPlanEntry({ date: "2026-09-29", slot: "dinner", title: "Tacos" });
    const other = await openOtherTab();
    const [here, there] = createChannelPair();
    setDataChannelFactoryForTests(() => here);
    other.feed.setDataChannelFactoryForTests(() => there);
    await loadMealPlan();
    const titlesShown = () => getMealPlanSnapshot().data.map((shown) => shown.title);
    const held = holdNextWrite(await getLinkDishWebDb(), "delete");

    const removing = removeMealPlanEntryOptimistic(entry.id);
    await held.started;
    expect(titlesShown()).toEqual(["Tacos"]);

    // The other tab removes Tacos while this tab's removal is pending; this tab re-reads the plan.
    await other.store.removeMealPlanEntry(tacos.id);
    await waitFor(() => expect(titlesShown()).not.toContain("Tacos"));
    held.fail(new Error("disk full"));
    await expect(removing).rejects.toThrow("disk full");

    expect(titlesShown()).toEqual(["Lemony pasta"]);
    expect(storedEntry(tacos.id)).toBeUndefined();
    expect(storedEntry(entry.id)).toMatchObject({ title: "Lemony pasta" });
  });
});
