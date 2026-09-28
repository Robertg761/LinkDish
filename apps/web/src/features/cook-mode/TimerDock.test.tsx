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
import { formatTimerClock, sortTimersForDock, TimerDock } from "./TimerDock";

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

  it("collapses several timers into one card (the soonest first) with +N to expand", () => {
    render(
      <MemoryRouter initialEntries={["/shopping"]}>
        <TimerDock />
      </MemoryRouter>
    );

    act(() => {
      startKitchenTimer({
        durationMs: 8 * 60_000,
        href: "/recipes/r1",
        label: "8 min",
        recipeId: "r1",
        recipeTitle: "Short Ribs",
        stepIndex: 1
      });
      startKitchenTimer({
        durationMs: 60_000,
        href: "/recipes/r1",
        label: "1 min",
        recipeId: "r1",
        recipeTitle: "Short Ribs",
        stepIndex: 2
      });
    });

    // One card, the timer that ends first.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("1:00")).toBeInTheDocument();
    expect(screen.queryByText("8:00")).not.toBeInTheDocument();
    // Away from its recipe, the card names the recipe.
    expect(screen.getByRole("link", { name: "Short Ribs" })).toBeInTheDocument();

    const more = screen.getByRole("button", { name: "Show all 2 timers" });
    expect(more).toHaveTextContent("+1 more");
    expect(more).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(more);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show only the next timer" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    // Back to one card once only one timer is left.
    fireEvent.click(screen.getByRole("button", { name: "Cancel 8 min timer" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Show all/u })).not.toBeInTheDocument();
  });

  it("labels timers by step (not by recipe) on the recipe that started them", () => {
    render(
      <MemoryRouter initialEntries={["/recipes/r1"]}>
        <TimerDock />
      </MemoryRouter>
    );

    act(() => {
      startKitchenTimer({
        durationMs: 10 * 60_000,
        href: "/recipes/r1",
        label: "10 min",
        recipeId: "r1",
        recipeTitle: "Banana Bread",
        stepIndex: 4
      });
    });

    const card = screen.getByRole("listitem");
    expect(card).toHaveTextContent("Step 5");
    expect(card).toHaveTextContent("10 min");
    expect(card).not.toHaveTextContent("Banana Bread");
  });

  it("publishes its height so pages can keep their last rows clear of it", () => {
    render(
      <MemoryRouter>
        <TimerDock />
      </MemoryRouter>
    );
    expect(document.documentElement.dataset.timerDock).toBeUndefined();

    act(() => {
      startKitchenTimer({
        durationMs: 60_000,
        label: "1 min",
        recipeId: "r1",
        recipeTitle: "Tea"
      });
    });

    expect(document.documentElement.dataset.timerDock).toBe("");
    expect(document.documentElement.style.getPropertyValue("--timer-dock-height")).toMatch(/px$/u);

    act(() => {
      resetKitchenTimersForTests();
    });
    expect(document.documentElement.dataset.timerDock).toBeUndefined();
  });

  it("sorts ringing timers first, then the soonest, then paused ones", () => {
    const base = { durationMs: 60_000, recipeId: "r", recipeTitle: "R" };
    const now = Date.now();
    const sorted = sortTimersForDock(
      [
        {
          ...base,
          endsAt: now + 50_000,
          id: "paused",
          label: "p",
          paused: true,
          remainingMs: 10_000
        },
        { ...base, endsAt: now + 90_000, id: "later", label: "l", paused: false },
        { ...base, doneAt: now - 1000, endsAt: now - 1000, id: "done", label: "d", paused: false },
        { ...base, endsAt: now + 30_000, id: "soon", label: "s", paused: false }
      ],
      now
    );

    expect(sorted.map((timer) => timer.id)).toEqual(["done", "soon", "later", "paused"]);
  });
});
