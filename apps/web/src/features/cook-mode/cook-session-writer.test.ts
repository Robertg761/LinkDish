import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  getCookSession,
  resetCookSessionStoreForTests,
  saveCookSession,
  startCookTimer,
  useCookSession
} from "../../data/cook-session-store";
import { COOK_SESSIONS_STORE_NAME, resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  flushCookSessionWrites,
  queueCookSessionReset,
  queueCookSessionUpdate
} from "./cook-session-writer";

import type { CookSession } from "../../data/cook-session-store";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const NOW = Date.now();

interface FakeChannel {
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

/** Two BroadcastChannel ends: what one tab posts, the other hears. */
const createChannelPair = (): [FakeChannel, FakeChannel] => {
  const ends: FakeChannel[] = [];
  const end = (index: number): FakeChannel => ({
    close: () => undefined,
    onmessage: null,
    postMessage: (message) => {
      setTimeout(() => ends[1 - index]?.onmessage?.({ data: message } as MessageEvent), 0);
    }
  });
  ends.push(end(0), end(1));
  return [ends[0]!, ends[1]!];
};

/**
 * Another tab on the same database: fresh copies of the storage connection, change feed, cache and
 * per-recipe write queue (this file's static imports are the first tab). `idb` stays mocked by the
 * one shared fake database.
 */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("../../data/change-feed");
  const store = await import("../../data/cook-session-store");
  const writer = await import("./cook-session-writer");
  return { feed, store, writer };
};

const storedSession = (recipeId: string) =>
  fakeIdb.record<CookSession>(COOK_SESSIONS_STORE_NAME, recipeId);

describe("cook-session writes from two tabs", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    fakeIdb.isolateTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    await saveCookSession(
      { checkedIngredients: ["salt"], recipeId: "r1", scale: 1, stepIndex: 1, timers: [] },
      NOW
    );
  });

  afterEach(async () => {
    await flushCookSessionWrites();
    setDataChannelFactoryForTests(() => null);
  });

  it("keeps a step change from one tab and a timer from the other", async () => {
    const other = await openOtherTab();
    const [here, there] = createChannelPair();
    setDataChannelFactoryForTests(() => here);
    other.feed.setDataChannelFactoryForTests(() => there);
    const hereView = renderHook(() => useCookSession("r1"));
    const thereView = renderHook(() => other.store.useCookSession("r1"));
    await waitFor(() => {
      expect(hereView.result.current.session?.stepIndex).toBe(1);
      expect(thereView.result.current.session?.stepIndex).toBe(1);
    });
    const timer = startCookTimer({ durationMs: 300_000, id: "t1", label: "Simmer" });

    await act(async () => {
      await Promise.all([
        queueCookSessionUpdate("r1", { stepIndex: 3 }),
        other.writer.queueCookSessionUpdate("r1", (session) => ({
          timers: [...session.timers, timer]
        }))
      ]);
    });

    expect(storedSession("r1")).toMatchObject({
      checkedIngredients: ["salt"],
      stepIndex: 3,
      timers: [timer]
    });

    // Each tab shows both changes (its own write, then the other tab's announced one).
    const both = { stepIndex: 3, timers: [timer] };
    await waitFor(() => {
      expect(hereView.result.current.session).toMatchObject(both);
      expect(thereView.result.current.session).toMatchObject(both);
    });
  });

  it("keeps a timer the other tab starts while this tab ends the cook", async () => {
    const other = await openOtherTab();
    const timer = startCookTimer({ durationMs: 300_000, id: "t1", label: "Rest" });

    await Promise.all([
      queueCookSessionReset("r1"),
      other.writer.queueCookSessionUpdate("r1", (session) => ({
        timers: [...session.timers, timer]
      }))
    ]);

    expect(await getCookSession("r1")).toMatchObject({
      checkedIngredients: [],
      stepIndex: 0,
      timers: [timer]
    });
  });
});
