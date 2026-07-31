import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CookMode } from "./CookMode";

import type { Recipe } from "@linkdish/recipe-domain";

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

const recipe: Recipe = {
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: "jsonld",
      ingredients: "jsonld",
      nutrition: null,
      prepTimeMinutes: "jsonld",
      servings: "jsonld",
      steps: "jsonld",
      title: "jsonld"
    },
    missingFields: [],
    notes: [],
    score: 0.95,
    summary: "High confidence"
  },
  cookTimeMinutes: 20,
  ingredients: [
    { section: "Dry", text: "1 cup flour" },
    { section: "Dry", text: "1 tsp baking powder" },
    { section: "Wet", text: "1 egg" }
  ],
  nutrition: null,
  prepTimeMinutes: 10,
  servings: "4",
  sourceType: "recipe-webpage",
  sourceUrl: "https://example.com/pancakes",
  steps: [
    { index: 1, text: "Whisk the dry ingredients." },
    { index: 2, text: "Mix in the wet ingredients." }
  ],
  title: "Pancakes"
};

const advanceCookModeTransition = () => {
  act(() => {
    vi.advanceTimersByTime(340);
  });
};

describe("CookMode", () => {
  const originalNotification = window.Notification;
  const originalAudioContext = window.AudioContext;

  const notificationMock = vi.fn();
  const requestPermissionMock = vi.fn();
  const oscillatorStartMock = vi.fn();
  const oscillatorStopMock = vi.fn();

  class MockNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = requestPermissionMock;

    constructor(title: string, options?: NotificationOptions) {
      notificationMock(title, options);
    }
  }

  class MockAudioContext {
    currentTime = 0;
    destination = {};

    close = vi.fn().mockResolvedValue(undefined);
    createGain = vi.fn(() => ({
      connect: vi.fn(),
      gain: {
        exponentialRampToValueAtTime: vi.fn(),
        setValueAtTime: vi.fn()
      }
    }));
    createOscillator = vi.fn(() => ({
      connect: vi.fn(),
      frequency: { value: 0 },
      start: oscillatorStartMock,
      stop: oscillatorStopMock,
      type: "sine"
    }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    MockNotification.permission = "default";
    requestPermissionMock.mockReset();
    requestPermissionMock.mockResolvedValue("granted");
    notificationMock.mockReset();
    oscillatorStartMock.mockReset();
    oscillatorStopMock.mockReset();
    analyticsMocks.trackWebEvent.mockReset();
    localStorage.clear();
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: originalNotification
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: originalAudioContext
    });
    document.body.style.overflow = "";
    document.title = "";
  });

  it("matches the Android cook mode flow for steps, ingredients, and finish", () => {
    const { container } = render(<CookMode recipe={recipe} />);

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_started",
      routeOrScreen: "recipe",
      properties: {
        entry_point: "recipe_detail",
        step_count: 2
      }
    });

    expect(screen.getByRole("dialog", { name: "Cooking mode for Pancakes" })).toBeInTheDocument();
    expect(screen.getByText("Whisk the dry ingredients.")).toBeInTheDocument();
    expect(
      screen.getAllByText((_content, element) => element?.textContent === "Step 1 of 2").length
    ).toBeGreaterThan(0);
    expect(container.querySelector(".cook-mode-bold-step-text")).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous step" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /keep awake/i })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Toggle ingredients visibility" }));

    expect(screen.getByText("Dry")).toBeInTheDocument();
    const flourCheckbox = screen.getByRole("checkbox", { name: "1 cup flour" });

    expect(flourCheckbox).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("1 cup flour")).toBeInTheDocument();
    expect(screen.getByText("Wet")).toBeInTheDocument();

    fireEvent.click(flourCheckbox);
    expect(flourCheckbox).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    advanceCookModeTransition();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous step" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish cooking" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    advanceCookModeTransition();

    expect(screen.getByText("Bon appétit!")).toBeInTheDocument();
    expect(screen.getByText("You cooked Pancakes.")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_completed",
      routeOrScreen: "recipe",
      properties: {
        elapsed_seconds: 1,
        step_count: 2
      }
    });
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    const progressBar = document.querySelector<HTMLElement>(".cook-mode-progress-bar-fill");
    expect(progressBar).toHaveStyle({ width: "100%" });

    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    advanceCookModeTransition();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    advanceCookModeTransition();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(
      screen.queryByRole("dialog", { name: "Cooking mode for Pancakes" })
    ).not.toBeInTheDocument();
  });

  it("shows first-entry cook mode hints once", () => {
    render(<CookMode recipe={recipe} />);

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    expect(screen.getByText("Tap the sides to move through steps.")).toBeInTheDocument();
    expect(screen.getByText("Tap ingredients to check them off.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(localStorage.getItem("linkdish:web:cook-mode-hints-seen:v1")).toBe("true");
    expect(screen.queryByText("Tap the sides to move through steps.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    expect(screen.queryByText("Tap the sides to move through steps.")).not.toBeInTheDocument();
  });

  it("renders timer chips for step durations and not temperature-only steps", () => {
    render(
      <CookMode
        recipe={{
          ...recipe,
          steps: [
            { index: 1, text: "Bake until set, 30–35 minutes." },
            { index: 2, text: "Heat the oven to 350°F." }
          ]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    expect(screen.getByRole("button", { name: /30–35 min/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    advanceCookModeTransition();

    expect(screen.getByText("Heat the oven to 350°F.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /350/i })).not.toBeInTheDocument();
  });

  it("pins running timers, requests notification permission once, and announces completion", () => {
    MockNotification.permission = "granted";
    render(
      <CookMode
        recipe={{
          ...recipe,
          steps: [{ index: 1, text: "Rest the batter for 1 minute." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 minute/i }));

    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(screen.getByText("Step 1 · 1 minute")).toBeInTheDocument();
    expect(screen.getByText("01:00")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(oscillatorStartMock).toHaveBeenCalled();
    expect(notificationMock).toHaveBeenCalledWith("LinkDish timer done", {
      body: "Pancakes: 1 minute"
    });
  });

  it("requests notification permission on the first timer start when permission is undecided", () => {
    render(
      <CookMode
        recipe={{
          ...recipe,
          steps: [{ index: 1, text: "Rest the batter for 1 minute." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 minute/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 minute/i }));

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
  });

  it("uses an app-native leave confirmation while a timer is running", () => {
    render(
      <CookMode
        recipe={{
          ...recipe,
          steps: [{ index: 1, text: "Rest the batter for 1 minute." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 minute/i }));
    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));

    const firstDialog = screen.getByRole("dialog", { name: "Timers are still running" });
    expect(screen.getByRole("dialog", { name: "Cooking mode for Pancakes" })).toBeInTheDocument();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Keep cooking" }));
    expect(
      screen.queryByRole("dialog", { name: "Timers are still running" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    const confirmation = screen.getByRole("dialog", { name: "Timers are still running" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Leave" }));

    expect(
      screen.queryByRole("dialog", { name: "Cooking mode for Pancakes" })
    ).not.toBeInTheDocument();
  });

  it("accepts natural swipes without turning their synthetic click into another step", () => {
    render(<CookMode recipe={recipe} />);
    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    const stepArea = document.querySelector<HTMLElement>(".cook-mode-step-area");
    expect(stepArea).not.toBeNull();

    fireEvent.touchStart(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 220, pageY: 120 }]
    });
    fireEvent.touchMove(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 178, pageY: 170 }]
    });
    fireEvent.touchEnd(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 178, pageY: 170 }]
    });
    fireEvent.click(stepArea as HTMLElement, { clientX: 350 });
    expect(screen.getByText("Whisk the dry ingredients.")).toBeInTheDocument();

    fireEvent.touchStart(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 220, pageY: 120 }]
    });
    fireEvent.touchMove(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 176, pageY: 148 }]
    });
    fireEvent.touchEnd(stepArea as HTMLElement, {
      changedTouches: [{ pageX: 176, pageY: 148 }]
    });
    fireEvent.click(stepArea as HTMLElement, { clientX: 350 });
    advanceCookModeTransition();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.queryByText("Bon appétit!")).not.toBeInTheDocument();
  });

  it("advances from side taps once and ignores repeated input during a transition", () => {
    render(<CookMode recipe={recipe} />);
    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    const stepArea = document.querySelector<HTMLElement>(".cook-mode-step-area");
    expect(stepArea).not.toBeNull();
    vi.spyOn(stepArea as HTMLElement, "getBoundingClientRect").mockReturnValue({
      bottom: 700,
      height: 600,
      left: 0,
      right: 390,
      toJSON: () => ({}),
      top: 100,
      width: 390,
      x: 0,
      y: 100
    });

    fireEvent.click(stepArea as HTMLElement, { clientX: 350 });
    fireEvent.click(stepArea as HTMLElement, { clientX: 350 });
    fireEvent.click(stepArea as HTMLElement, { clientX: 350 });
    expect(screen.getByRole("button", { name: "Next step" })).toBeDisabled();
    advanceCookModeTransition();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.queryByText("Bon appétit!")).not.toBeInTheDocument();
  });

  it("shows matched ingredients below the current step", () => {
    render(
      <CookMode
        recipe={{
          ...recipe,
          steps: [{ index: 1, text: "Whisk the flour and egg until smooth." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));

    expect(screen.getByText("1 cup flour")).toBeInTheDocument();
    expect(screen.getByText("1 egg")).toBeInTheDocument();
    expect(screen.queryByText("1 tsp baking powder")).not.toBeInTheDocument();
  });

  it("scales confident ingredient lines and keeps unconfident lines honest", () => {
    render(
      <CookMode
        recipe={{
          ...recipe,
          ingredients: [{ text: "1 cup flour" }, { text: "Salt to taste" }],
          steps: [{ index: 1, text: "Mix the flour with salt." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cook mode/i }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle ingredients visibility" }));

    expect(
      screen.queryByText("Some ingredients can’t be scaled automatically.")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2×" }));

    expect(screen.getAllByText("2 cups flour").length).toBeGreaterThan(0);
    expect(screen.getByText("Salt to taste")).toBeInTheDocument();
    expect(screen.getByText("Some ingredients can’t be scaled automatically.")).toBeInTheDocument();
  });
});
