import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  trackMobileEvent: vi.fn()
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("../../analytics/client", () => analyticsMocks);

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined })
  }
}));

import { MealPlanProvider, useMealPlan, WEEK_STARTS_ON_STORAGE_KEY } from "./MealPlanContext";
import { MEAL_PLAN_STORAGE_KEY, type MealPlanEntry } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useMealPlan> | null = null;

const Probe = () => {
  latest = useMealPlan();
  return null;
};

const stored: MealPlanEntry = {
  createdAt: "2026-10-20T12:00:00.000Z",
  date: "2026-10-27",
  id: "plan-stored",
  recipeId: "saved-1",
  servings: 4,
  slot: "dinner",
  title: "Onion soup",
  updatedAt: "2026-10-20T12:00:00.000Z"
};

const render = async () => {
  let renderer: ReturnType<typeof create> | undefined;

  await act(async () => {
    renderer = create(
      <MealPlanProvider>
        <Probe />
      </MealPlanProvider>
    );
    await Promise.resolve();
  });

  return renderer!;
};

const lastWrittenPlan = (): MealPlanEntry[] => {
  const calls = asyncStorageMocks.setItem.mock.calls.filter(
    ([key]) => key === MEAL_PLAN_STORAGE_KEY
  );
  return JSON.parse(String(calls[calls.length - 1]?.[1] ?? "[]")) as MealPlanEntry[];
};

describe("MealPlanProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.setItem.mockReset().mockResolvedValue(undefined);
    analyticsMocks.trackMobileEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the stored plan and week start, then saves what is added", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(
        key === MEAL_PLAN_STORAGE_KEY
          ? JSON.stringify([stored])
          : key === WEEK_STARTS_ON_STORAGE_KEY
            ? "1"
            : null
      )
    );
    await render();

    expect(latest?.hasLoadedMealPlan).toBe(true);
    expect(latest?.entries).toEqual([stored]);
    expect(latest?.weekStartsOn).toBe(1);

    act(() => {
      latest?.addEntry({ date: "2026-10-26", slot: "lunch", title: "Leftovers" }, "plan");
    });

    expect(latest?.entries.map((entry) => entry.title)).toEqual(["Leftovers", "Onion soup"]);
    expect(analyticsMocks.trackMobileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "meal_plan_entry_added",
        properties: { kind: "note", slot: "lunch", source: "plan" }
      })
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(lastWrittenPlan().map((entry) => entry.title)).toEqual(["Leftovers", "Onion soup"]);
  });

  it("moves, rescales and removes entries", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === MEAL_PLAN_STORAGE_KEY ? JSON.stringify([stored]) : null)
    );
    await render();

    act(() => {
      latest?.updateEntry("plan-stored", { date: "2026-10-29", servings: 2, slot: "lunch" });
    });

    expect(latest?.entries[0]).toMatchObject({ date: "2026-10-29", servings: 2, slot: "lunch" });

    act(() => {
      latest?.removeEntry("plan-stored");
    });

    expect(latest?.entries).toEqual([]);
  });

  it("never writes over a plan it could not read", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      key === MEAL_PLAN_STORAGE_KEY ? Promise.reject(new Error("disk")) : Promise.resolve(null)
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await render();

    act(() => {
      latest?.addEntry({ date: "2026-10-26", slot: "dinner", title: "Takeout" }, "plan");
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(
      asyncStorageMocks.setItem.mock.calls.filter(([key]) => key === MEAL_PLAN_STORAGE_KEY)
    ).toEqual([]);
  });

  it("imports only entries it doesn't have and saves them right away", async () => {
    asyncStorageMocks.getItem.mockImplementation((key: string) =>
      Promise.resolve(key === MEAL_PLAN_STORAGE_KEY ? JSON.stringify([stored]) : null)
    );
    await render();
    let imported = 0;

    await act(async () => {
      imported =
        (await latest?.importEntries([
          stored,
          { ...stored, date: "2026-10-30", id: "plan-backup" }
        ])) ?? 0;
    });

    expect(imported).toBe(1);
    expect(lastWrittenPlan().map((entry) => entry.id)).toEqual(["plan-stored", "plan-backup"]);
  });
});
