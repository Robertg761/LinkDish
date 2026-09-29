import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  getCookSession,
  resetCookSessionStoreForTests,
  startCookTimer,
  updateCookSession
} from "../../data/cook-session-store";
import {
  COOK_SESSIONS_STORE_NAME,
  getLinkDishWebDb,
  resetLinkDishWebDbForTests
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { deleteSavedRecipe } from "../library/saved-recipe-store";

import { flushCookSessionWrites } from "./cook-session-writer";
import {
  flashDocumentTitle,
  resetTimerAlertsForTests,
  showTimerNotification
} from "./timer-alerts";
import {
  addKitchenTimerTime,
  dismissKitchenTimer,
  getKitchenTimers,
  getTimerRemainingMs,
  hydrateKitchenTimers,
  pauseKitchenTimer,
  resetKitchenTimersForTests,
  resumeKitchenTimer,
  startKitchenTimer
} from "./timer-store";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const analytics = vi.hoisted(() => ({ trackWebEvent: vi.fn<(event: unknown) => void>() }));
vi.mock("../../analytics/client", () => ({ trackWebEvent: analytics.trackWebEvent }));

const NOW = Date.parse("2026-09-28T18:00:00.000Z");

const oscillatorStart = vi.fn();

class MockAudioContext {
  currentTime = 0;
  destination = {};
  state = "running";
  resume = vi.fn().mockResolvedValue(undefined);
  createGain = vi.fn(() => ({
    connect: vi.fn(),
    gain: { exponentialRampToValueAtTime: vi.fn(), setValueAtTime: vi.fn() }
  }));
  createOscillator = vi.fn(() => ({
    connect: vi.fn(),
    frequency: { value: 0 },
    start: oscillatorStart,
    stop: vi.fn(),
    type: "sine"
  }));
}

const notificationConstructor = vi.fn();
const requestPermission = vi.fn();

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = requestPermission;

  constructor(title: string, options?: NotificationOptions) {
    notificationConstructor(title, options);
  }
}

const setServiceWorker = (value: unknown) => {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value });
};

const flushAsync = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("kitchen timers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    setDataChannelFactoryForTests(() => null);
    resetKitchenTimersForTests();
    resetTimerAlertsForTests();
    oscillatorStart.mockReset();
    notificationConstructor.mockReset();
    requestPermission.mockReset().mockResolvedValue("granted");
    MockNotification.permission = "granted";
    Object.defineProperty(window, "AudioContext", { configurable: true, value: MockAudioContext });
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
    setServiceWorker(undefined);
    document.title = "Banana Bread · LinkDish";
  });

  afterEach(async () => {
    resetKitchenTimersForTests();
    resetTimerAlertsForTests();
    await flushCookSessionWrites();
    vi.useRealTimers();
  });

  it("counts down, pauses, resumes, adds a minute and dismisses", () => {
    const id = startKitchenTimer({
      durationMs: 60_000,
      label: "1 min",
      recipeId: "r1",
      recipeTitle: "Pancakes",
      stepIndex: 0
    });

    vi.advanceTimersByTime(20_000);
    const timer = () => getKitchenTimers().find((entry) => entry.id === id)!;
    expect(getTimerRemainingMs(timer())).toBe(40_000);

    pauseKitchenTimer(id);
    vi.advanceTimersByTime(30_000);
    expect(timer()).toMatchObject({ paused: true, remainingMs: 40_000 });

    resumeKitchenTimer(id);
    addKitchenTimerTime(id, 60_000);
    expect(getTimerRemainingMs(timer())).toBe(100_000);

    dismissKitchenTimer(id);
    expect(getKitchenTimers()).toHaveLength(0);
  });

  it("chimes and notifies through the service worker when a timer finishes", async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    setServiceWorker({ ready: Promise.resolve({ showNotification }) });

    startKitchenTimer({
      durationMs: 60_000,
      label: "1 min",
      recipeId: "r1",
      recipeTitle: "Pancakes",
      stepIndex: 1
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getKitchenTimers()[0]?.doneAt).toBeDefined();
    expect(oscillatorStart).toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledWith(
      "Your 1 min timer is done",
      expect.objectContaining({ body: "Pancakes · Step 2" })
    );
    expect(notificationConstructor).not.toHaveBeenCalled();
  });

  it("reports each timer started", () => {
    analytics.trackWebEvent.mockReset();

    startKitchenTimer({
      durationMs: 90_000,
      label: "1½ min",
      recipeId: "r1",
      recipeTitle: "Pancakes",
      stepIndex: 1
    });
    startKitchenTimer({ durationMs: 600_000, label: "10 min", recipeId: "r1", recipeTitle: "R" });

    expect(analytics.trackWebEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        eventName: "cook_timer_started",
        properties: { duration_seconds: 90, from_step: true }
      }),
      expect.objectContaining({
        eventName: "cook_timer_started",
        properties: { duration_seconds: 600, from_step: false }
      })
    ]);
  });

  it("asks for notification permission once, on the first timer", () => {
    MockNotification.permission = "default";

    startKitchenTimer({ durationMs: 60_000, label: "a", recipeId: "r1", recipeTitle: "R" });
    startKitchenTimer({ durationMs: 60_000, label: "b", recipeId: "r1", recipeTitle: "R" });

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("persists timers in the recipe's cook session and restores them after a reload", async () => {
    startKitchenTimer({
      durationMs: 300_000,
      href: "/recipes/r1",
      label: "5 min",
      recipeId: "r1",
      recipeTitle: "Pancakes",
      stepIndex: 2
    });
    await flushAsync();
    await flushCookSessionWrites();

    const session = await getCookSession("r1");
    expect(session?.timers).toEqual([
      expect.objectContaining({ label: "5 min", recipeTitle: "Pancakes", stepIndex: 2 })
    ]);

    resetKitchenTimersForTests();
    resetCookSessionStoreForTests();
    expect(getKitchenTimers()).toHaveLength(0);

    await hydrateKitchenTimers();
    expect(getKitchenTimers()).toEqual([
      expect.objectContaining({ href: "/recipes/r1", label: "5 min", recipeId: "r1" })
    ]);
  });

  it("reads saved timers again once storage works after a failed first read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startKitchenTimer({
      durationMs: 300_000,
      href: "/recipes/r1",
      label: "5 min",
      recipeId: "r1",
      recipeTitle: "Pancakes"
    });
    await flushAsync();
    await flushCookSessionWrites();

    // A later page load whose first read of the saved timers fails.
    resetKitchenTimersForTests();
    resetCookSessionStoreForTests();
    resetLinkDishWebDbForTests();
    fakeIdb.failNextOpen(new DOMException("Storage is unavailable.", "UnknownError"));
    const firstRead = hydrateKitchenTimers();
    await flushAsync();
    await firstRead;
    expect(getKitchenTimers()).toHaveLength(0);

    // Storage works again: the next caller (the dock shown again, a new timer) reads them.
    const nextRead = hydrateKitchenTimers();
    await flushAsync();
    await nextRead;
    expect(getKitchenTimers()).toEqual([
      expect.objectContaining({ label: "5 min", recipeId: "r1" })
    ]);
  });

  it("reads saved timers again when the page is shown after a failed first read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startKitchenTimer({ durationMs: 300_000, label: "5 min", recipeId: "r1", recipeTitle: "Stew" });
    await flushAsync();
    await flushCookSessionWrites();
    resetKitchenTimersForTests();
    resetCookSessionStoreForTests();
    resetLinkDishWebDbForTests();
    fakeIdb.failNextOpen(new DOMException("Storage is unavailable.", "UnknownError"));
    const firstRead = hydrateKitchenTimers();
    await flushAsync();
    await firstRead;
    expect(getKitchenTimers()).toHaveLength(0);

    document.dispatchEvent(new Event("visibilitychange"));
    await flushAsync();
    await flushAsync();

    expect(getKitchenTimers()).toEqual([
      expect.objectContaining({ label: "5 min", recipeId: "r1" })
    ]);
  });

  describe("when this tab's stored timers change or can't be saved", () => {
    beforeEach(async () => {
      // Open the database up front (its upgrade waits on timers, which are fake here).
      const opening = getLinkDishWebDb();
      await vi.advanceTimersByTimeAsync(0);
      await opening;
    });

    it("still chimes for a timer whose first save failed", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await hydrateKitchenTimers();
      fakeIdb.failNextPut(
        COOK_SESSIONS_STORE_NAME,
        new DOMException("The quota has been exceeded.", "QuotaExceededError")
      );

      startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      await flushAsync();
      await flushCookSessionWrites().catch(() => undefined);
      expect((await getCookSession("r1"))?.timers ?? []).toEqual([]);

      // Only this tab knows the timer: it announces it when it runs out.
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsync();
      await flushCookSessionWrites().catch(() => undefined);
      await flushAsync();

      expect(oscillatorStart).toHaveBeenCalled();
    });

    it("drops the deleted recipe's timers and keeps the others", async () => {
      await hydrateKitchenTimers();
      startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      const kept = startKitchenTimer({
        durationMs: 90_000,
        label: "Rest",
        recipeId: "r2",
        recipeTitle: "Bread"
      });
      await flushAsync();
      await flushCookSessionWrites();

      // Deleting the recipe deletes its cook session (and the timers stored in it).
      await deleteSavedRecipe("r1", { snapshot: false });
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();

      expect(getKitchenTimers().map((timer) => timer.id)).toEqual([kept]);
    });

    it("keeps timer changes waiting to be saved when deleting their recipe fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await hydrateKitchenTimers();
      const id = startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      fakeIdb.failNextDelete(
        COOK_SESSIONS_STORE_NAME,
        new DOMException("The recipe could not be deleted.", "UnknownError")
      );

      await expect(deleteSavedRecipe("r1", { snapshot: false })).rejects.toThrow();
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();

      expect((await getCookSession("r1"))?.timers).toEqual([
        expect.objectContaining({ id, label: "Boil" })
      ]);
      expect(getKitchenTimers().map((timer) => timer.id)).toEqual([id]);
    });

    it("doesn't bring a deleted recipe's timers back from changes still waiting to be saved", async () => {
      await hydrateKitchenTimers();
      const id = startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      pauseKitchenTimer(id);

      // Deleted before either change is saved.
      await deleteSavedRecipe("r1", { snapshot: false });
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();

      expect(await getCookSession("r1")).toBeUndefined();
      expect(getKitchenTimers()).toEqual([]);

      // A timer started for it afterwards (the delete undone, say) is saved as usual.
      startKitchenTimer({
        durationMs: 30_000,
        label: "Stir",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      await flushAsync();
      await flushCookSessionWrites();
      expect((await getCookSession("r1"))?.timers).toEqual([
        expect.objectContaining({ label: "Stir" })
      ]);
    });
  });

  describe("with the app open in another tab", () => {
    beforeEach(async () => {
      // Open the database up front (its upgrade waits on timers, which are fake here).
      const opening = getLinkDishWebDb();
      await vi.advanceTimersByTimeAsync(0);
      await opening;
    });

    /** The BroadcastChannel stand-in: `deliver` is another tab's write notification. */
    const crossTab = () => {
      const channel = {
        close: vi.fn(),
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: vi.fn()
      };
      setDataChannelFactoryForTests(() => channel);

      return {
        deliver: async () => {
          channel.onmessage?.({ data: { topic: "cookSessions", v: 1 } } as MessageEvent);
          await flushAsync();
          await flushCookSessionWrites();
          await flushAsync();
        },
        /** The other tab deleted the recipe (and its cook session with it), as it says so. */
        deliverRecipeDeletion: (recipeId: string) => {
          for (const topic of ["savedRecipes", "cookSessions"]) {
            channel.onmessage?.({ data: { deletedIds: [recipeId], topic, v: 1 } } as MessageEvent);
          }
        }
      };
    };

    const storedTimer = (id: string, extra: Record<string, unknown> = {}) => ({
      ...startCookTimer({ durationMs: 60_000, id, label: "1 min" }),
      recipeTitle: "Chili",
      ...extra
    });

    const storedIds = async (recipeId: string) =>
      ((await getCookSession(recipeId))?.timers ?? []).map((timer) => timer.id);

    it("doesn't bring back a recipe the other tab deleted from changes still waiting to be saved", async () => {
      const other = crossTab();
      await hydrateKitchenTimers();
      startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });

      // The other tab deletes the recipe before this tab's change is saved.
      other.deliverRecipeDeletion("r1");
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();
      await flushCookSessionWrites();
      await flushAsync();

      expect(await getCookSession("r1")).toBeUndefined();
      expect(getKitchenTimers()).toEqual([]);
    });

    it("drops a timer dismissed in the other tab and never writes it back", async () => {
      const other = crossTab();
      await updateCookSession("r1", { timers: [storedTimer("t1")] });
      await hydrateKitchenTimers();
      expect(getKitchenTimers().map((timer) => timer.id)).toEqual(["t1"]);

      // The other tab dismisses t1.
      await updateCookSession("r1", { timers: [] });
      await other.deliver();
      expect(getKitchenTimers()).toEqual([]);

      const id = startKitchenTimer({
        durationMs: 30_000,
        label: "Rest",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      await flushAsync();
      await flushCookSessionWrites();

      expect(await storedIds("r1")).toEqual([id]);
    });

    it("keeps a timer the other tab started when this tab changes its own", async () => {
      const other = crossTab();
      const id = startKitchenTimer({
        durationMs: 60_000,
        label: "Boil",
        recipeId: "r1",
        recipeTitle: "Chili"
      });
      await flushAsync();
      await flushCookSessionWrites();

      // The other tab starts t2 before this tab has heard about it.
      const session = await getCookSession("r1");
      await updateCookSession("r1", { timers: [...(session?.timers ?? []), storedTimer("t2")] });
      pauseKitchenTimer(id);
      await flushAsync();
      await flushCookSessionWrites();

      expect(await storedIds("r1")).toEqual([id, "t2"]);

      await other.deliver();
      expect(getKitchenTimers().map((timer) => timer.id)).toEqual([id, "t2"]);
      expect(getKitchenTimers()[0]).toMatchObject({ paused: true });
    });

    it("lets only one tab announce a finished timer", async () => {
      crossTab();
      await updateCookSession("r1", { timers: [storedTimer("t1")] });
      await hydrateKitchenTimers();

      // The other tab noticed (and announced) the finish first.
      await vi.advanceTimersByTimeAsync(59_000);
      await updateCookSession("r1", {
        timers: [storedTimer("t1", { doneAt: NOW + 60_000, endsAt: NOW + 60_000 })]
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();
      await flushCookSessionWrites();

      expect(getKitchenTimers()[0]?.doneAt).toBeDefined();
      expect(oscillatorStart).not.toHaveBeenCalled();
      expect(document.title).not.toContain("Timer done");
    });
  });
});

describe("timer alerts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    resetTimerAlertsForTests();
    notificationConstructor.mockReset();
    MockNotification.permission = "granted";
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
    setServiceWorker(undefined);
  });

  afterEach(() => {
    resetTimerAlertsForTests();
    vi.useRealTimers();
  });

  it("falls back to the Notification constructor without a service worker", async () => {
    await expect(
      showTimerNotification({ body: "Pancakes", tag: "t", title: "Timer done" })
    ).resolves.toBe("constructor");
    expect(notificationConstructor).toHaveBeenCalledWith("Timer done", expect.anything());
  });

  it("fails silently where the constructor is illegal (Android Chrome)", async () => {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class {
        static permission = "granted";
        constructor() {
          throw new TypeError("Illegal constructor");
        }
      }
    });

    await expect(
      showTimerNotification({ body: "Pancakes", tag: "t", title: "Timer done" })
    ).resolves.toBe("none");
  });

  it("does nothing without permission", async () => {
    MockNotification.permission = "denied";

    await expect(showTimerNotification({ body: "", tag: "t", title: "Done" })).resolves.toBe(
      "none"
    );
    expect(notificationConstructor).not.toHaveBeenCalled();
  });

  it("restores the real title after overlapping flashes (no stuck 'Timer done')", () => {
    document.title = "Banana Bread · LinkDish";

    flashDocumentTitle("⏰ Timer done: Step 1");
    vi.advanceTimersByTime(800);
    expect(document.title).toBe("⏰ Timer done: Step 1");

    flashDocumentTitle("⏰ Timer done: Step 2");
    vi.advanceTimersByTime(800 * 20);

    expect(document.title).toBe("Banana Bread · LinkDish");
  });
});
