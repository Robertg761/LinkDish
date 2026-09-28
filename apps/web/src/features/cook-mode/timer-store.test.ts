import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { getCookSession, resetCookSessionStoreForTests } from "../../data/cook-session-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

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
