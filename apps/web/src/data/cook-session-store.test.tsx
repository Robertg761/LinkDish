import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COOK_SESSIONS_STORE_NAME, resetLinkDishWebDbForTests } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  cleanupExpiredCookSessions,
  clearCookSession,
  COOK_SESSION_TTL_MS,
  getCookSession,
  getCookTimerRemainingMs,
  isCookTimerDone,
  pauseCookTimer,
  resetCookSessionStoreForTests,
  resumeCookTimer,
  saveCookSession,
  startCookTimer,
  updateCookSession,
  useCookSession
} from "./cook-session-store";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

const NOW = Date.parse("2026-09-27T18:00:00.000Z");

describe("cook timers", () => {
  it("counts down, pauses and resumes", () => {
    const timer = startCookTimer({ durationMs: 60_000, id: "t1", label: "Simmer" }, NOW);
    expect(getCookTimerRemainingMs(timer, NOW + 20_000)).toBe(40_000);

    const paused = pauseCookTimer(timer, NOW + 20_000);
    expect(paused).toEqual({
      durationMs: 60_000,
      id: "t1",
      label: "Simmer",
      paused: true,
      remainingMs: 40_000
    });
    expect(getCookTimerRemainingMs(paused, NOW + 999_999)).toBe(40_000);

    const resumed = resumeCookTimer(paused, NOW + 100_000);
    expect(resumed.endsAt).toBe(NOW + 140_000);
    expect(isCookTimerDone(resumed, NOW + 139_999)).toBe(false);
    expect(isCookTimerDone(resumed, NOW + 140_000)).toBe(true);
    expect(getCookTimerRemainingMs(resumed, NOW + 200_000)).toBe(0);
  });
});

describe("cook-session-store", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    setDataChannelFactoryForTests(() => null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves and restores where you are in a recipe", async () => {
    const timer = startCookTimer({ durationMs: 300_000, id: "t1", label: "Rest" }, NOW);
    await saveCookSession(
      {
        checkedIngredients: ["salt", "salt", "flour"],
        recipeId: "r1",
        scale: 2,
        stepIndex: 3,
        timers: [timer]
      },
      NOW
    );

    expect(await getCookSession("r1", NOW + 1000)).toEqual({
      checkedIngredients: ["salt", "flour"],
      recipeId: "r1",
      scale: 2,
      stepIndex: 3,
      timers: [timer],
      updatedAt: new Date(NOW).toISOString()
    });
  });

  it("starts a fresh session on first update and merges later ones", async () => {
    const first = await updateCookSession("r2", { stepIndex: 1 }, NOW);
    expect(first).toMatchObject({ checkedIngredients: [], scale: 1, stepIndex: 1, timers: [] });

    const second = await updateCookSession(
      "r2",
      (session) => ({ checkedIngredients: [...session.checkedIngredients, "eggs"] }),
      NOW + 1000
    );
    expect(second).toMatchObject({ checkedIngredients: ["eggs"], stepIndex: 1 });

    const sanitized = await updateCookSession("r2", { scale: -1, stepIndex: 1.5 }, NOW + 2000);
    expect(sanitized).toMatchObject({ scale: 1, stepIndex: 0 });
  });

  it("keeps both of two concurrent updates (say, from two tabs)", async () => {
    fakeIdb.isolateTransactions();
    await updateCookSession("r4", { stepIndex: 1 }, NOW);

    // Each tab has its own write queue, so nothing but IndexedDB orders these two.
    await Promise.all([
      updateCookSession("r4", { stepIndex: 2 }, NOW + 1000),
      updateCookSession(
        "r4",
        (session) => ({ checkedIngredients: [...session.checkedIngredients, "eggs"] }),
        NOW + 1000
      )
    ]);

    expect(fakeIdb.record(COOK_SESSIONS_STORE_NAME, "r4")).toMatchObject({
      checkedIngredients: ["eggs"],
      stepIndex: 2
    });
  });

  it("expires sessions after 24 hours", async () => {
    await saveCookSession(
      { checkedIngredients: [], recipeId: "old", scale: 1, stepIndex: 2, timers: [] },
      NOW
    );
    await saveCookSession(
      { checkedIngredients: [], recipeId: "fresh", scale: 1, stepIndex: 0, timers: [] },
      NOW + COOK_SESSION_TTL_MS
    );

    const later = NOW + COOK_SESSION_TTL_MS + 1;
    expect(await getCookSession("fresh", later)).toBeDefined();
    expect(await getCookSession("old", later)).toBeUndefined();
    expect(fakeIdb.record(COOK_SESSIONS_STORE_NAME, "old")).toBeUndefined();

    await saveCookSession(
      { checkedIngredients: [], recipeId: "old", scale: 1, stepIndex: 2, timers: [] },
      NOW
    );
    expect(await cleanupExpiredCookSessions(later)).toBe(1);
    expect(fakeIdb.records(COOK_SESSIONS_STORE_NAME)).toHaveLength(1);
  });

  it("serves the live session through useCookSession", async () => {
    const { result } = renderHook(() => useCookSession("r3"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.session).toBeUndefined();

    await act(async () => {
      await updateCookSession("r3", { stepIndex: 4 });
    });
    expect(result.current.session?.stepIndex).toBe(4);

    await act(async () => {
      await clearCookSession("r3");
    });
    expect(result.current.session).toBeUndefined();
  });
});
