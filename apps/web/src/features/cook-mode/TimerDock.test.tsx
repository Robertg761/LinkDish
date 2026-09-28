import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCookSessionStoreForTests } from "../../data/cook-session-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { flushCookSessionWrites } from "./cook-session-writer";
import { resetTimerAlertsForTests } from "./timer-alerts";
import { getKitchenTimers, resetKitchenTimersForTests, startKitchenTimer } from "./timer-store";
import { formatTimerClock, TimerDock } from "./TimerDock";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

describe("TimerDock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T18:00:00.000Z") });
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    setDataChannelFactoryForTests(() => null);
    resetKitchenTimersForTests();
    resetTimerAlertsForTests();
    Object.defineProperty(window, "Notification", { configurable: true, value: undefined });
  });

  afterEach(async () => {
    resetKitchenTimersForTests();
    await flushCookSessionWrites();
    vi.useRealTimers();
  });

  it("formats countdowns", () => {
    expect(formatTimerClock(65_000)).toBe("1:05");
    expect(formatTimerClock(3_725_000)).toBe("1:02:05");
    expect(formatTimerClock(-5)).toBe("0:00");
  });

  it("shows running timers with pause, +1 min and cancel, and survives until dismissed", () => {
    render(
      <MemoryRouter>
        <TimerDock />
      </MemoryRouter>
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();

    act(() => {
      startKitchenTimer({
        durationMs: 90_000,
        href: "/recipes/r1",
        label: "1 hr",
        recipeId: "r1",
        recipeTitle: "Pancakes",
        stepIndex: 2
      });
    });

    expect(screen.getByText("1:30")).toBeInTheDocument();
    expect(screen.getByText("Step 3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pancakes" })).toHaveAttribute("href", "/recipes/r1");

    act(() => {
      vi.advanceTimersByTime(30_100);
    });
    expect(screen.getByText("1:00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause 1 hr timer" }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("1:00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Resume 1 hr timer" }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 minute to 1 hr timer" }));
    expect(screen.getByText("2:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(120_100);
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 hr timer is done.");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss finished 1 hr timer" }));
    expect(getKitchenTimers()).toHaveLength(0);
  });
});
