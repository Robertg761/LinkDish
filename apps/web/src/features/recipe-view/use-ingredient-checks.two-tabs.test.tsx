import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  loadCookSessions,
  resetCookSessionStoreForTests,
  saveCookSession
} from "../../data/cook-session-store";
import { COOK_SESSIONS_STORE_NAME, resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../../storage/testing/fake-idb-isolation";
import { flushCookSessionWrites } from "../cook-mode/cook-session-writer";

import { useIngredientChecks } from "./use-ingredient-checks";

import type { CookSession } from "../../data/cook-session-store";

vi.mock(
  "idb",
  async () => (await import("../../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);

/** Another tab on the same database: fresh copies of the connection, caches and write queue. */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("../../data/change-feed");
  const store = await import("../../data/cook-session-store");
  const writer = await import("../cook-mode/cook-session-writer");
  const checks = await import("./use-ingredient-checks");
  await (await import("../../storage/linkdish-db")).getLinkDishWebDb();
  feed.setDataChannelFactoryForTests(() => null);
  return { checks, store, writer };
};

const storedTicks = () =>
  [
    ...(fakeIdb.record<CookSession>(COOK_SESSIONS_STORE_NAME, "r1")?.checkedIngredients ?? [])
  ].sort();

describe("ingredient ticks from two tabs", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    setDataChannelFactoryForTests(() => null);
    await saveCookSession({
      checkedIngredients: ["0:1 onion"],
      recipeId: "r1",
      scale: 1,
      stepIndex: 0,
      timers: []
    });
  });

  afterEach(async () => {
    await flushCookSessionWrites();
  });

  it("keeps the ingredients both tabs tick at the same moment", async () => {
    const other = await openOtherTab();
    await Promise.all([loadCookSessions(), other.store.loadCookSessions()]);
    const here = renderHook(() => useIngredientChecks("r1"));
    const there = renderHook(() => other.checks.useIngredientChecks("r1"));

    // Each tab ticks one more line while it shows only the onion ticked.
    act(() => {
      here.result.current.toggle("1:2 cloves garlic");
      there.result.current.toggle("2:1 tsp salt");
    });
    await act(async () => {
      await Promise.all([flushCookSessionWrites(), other.writer.flushCookSessionWrites()]);
    });

    expect(storedTicks()).toEqual(["0:1 onion", "1:2 cloves garlic", "2:1 tsp salt"]);
  });

  it("keeps the other tab's tick when this one unticks a line", async () => {
    const other = await openOtherTab();
    await Promise.all([loadCookSessions(), other.store.loadCookSessions()]);
    const here = renderHook(() => useIngredientChecks("r1"));
    const there = renderHook(() => other.checks.useIngredientChecks("r1"));

    act(() => {
      here.result.current.toggle("0:1 onion");
      there.result.current.toggle("2:1 tsp salt");
    });
    await act(async () => {
      await Promise.all([flushCookSessionWrites(), other.writer.flushCookSessionWrites()]);
    });

    expect(storedTicks()).toEqual(["2:1 tsp salt"]);
  });
});
