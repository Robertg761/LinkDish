import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  getCookSession,
  resetCookSessionStoreForTests,
  saveCookSession
} from "../../data/cook-session-store";
import { resetPreferencesForTests } from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { flushCookSessionWrites } from "./cook-session-writer";
import { CookMode } from "./CookMode";
import { resetTimerAlertsForTests } from "./timer-alerts";
import { getKitchenTimers, resetKitchenTimersForTests } from "./timer-store";
import { TimerDock } from "./TimerDock";

import type { CookModeProps } from "./CookMode";
import type { Recipe } from "@linkdish/recipe-domain";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

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

const Harness: React.FC<Partial<CookModeProps> & { recipe?: Recipe }> = (props) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Start cooking
      </button>
      <CookMode
        onClose={() => setOpen(false)}
        {...props}
        open={open}
        recipe={props.recipe ?? recipe}
      />
    </>
  );
};

const openCookMode = () => {
  fireEvent.click(screen.getByRole("button", { name: "Start cooking" }));
};

/** Moves past the short input lock that keeps a double tap from skipping two steps. */
const settle = () => {
  act(() => {
    vi.advanceTimersByTime(300);
  });
};

const flushAsync = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const mockPointer = (coarse: boolean) => {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  }));
};

describe("CookMode", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-09-28T18:00:00.000Z") });
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCookSessionStoreForTests();
    setDataChannelFactoryForTests(() => null);
    resetKitchenTimersForTests();
    resetTimerAlertsForTests();
    resetPreferencesForTests();
    analyticsMocks.trackWebEvent.mockReset();
    localStorage.clear();
    mockPointer(false);
  });

  afterEach(async () => {
    cleanup();
    resetKitchenTimersForTests();
    await flushCookSessionWrites();
    vi.clearAllTimers();
    vi.useRealTimers();
    mockPointer(false);
    document.title = "";
  });

  it("walks through the steps, celebrates and reports start and finish", () => {
    const onClose = vi.fn();
    const onFinish = vi.fn();
    render(<CookMode onClose={onClose} onFinish={onFinish} open recipe={recipe} />);

    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_started",
      properties: { entry_point: "recipe_detail", step_count: 2 },
      routeOrScreen: "recipe"
    });

    const dialog = screen.getByRole("dialog", { name: "Cooking mode for Pancakes" });
    expect(within(dialog).getByText("Whisk the dry ingredients.")).toBeInTheDocument();
    // The step count is said once, in the step (not again in the header).
    expect(dialog.querySelector(".cook-step-eyebrow")).toHaveTextContent("Step 1 of 2");
    expect(dialog.querySelector(".cook-mode-subtitle")).toBeNull();
    // Back stays in the footer on step 1 (so it never jumps), just unavailable.
    expect(screen.getByRole("button", { name: "Previous step" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    settle();
    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous step" })).not.toHaveAttribute(
      "aria-disabled"
    );

    vi.advanceTimersByTime(1000);
    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    settle();

    expect(screen.getByText("Bon appétit!")).toBeInTheDocument();
    expect(screen.getByText("You cooked Pancakes.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progress" })).toHaveAttribute(
      "aria-valuenow",
      "2"
    );
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "cook_mode_completed",
      properties: { elapsed_seconds: 1, step_count: 2 },
      routeOrScreen: "recipe"
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
    // The finish screen has its own actions; the step footer steps aside.
    expect(dialog.querySelector(".cook-mode-footer")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to steps" }));
    settle();
    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish cooking" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    settle();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(
      analyticsMocks.trackWebEvent.mock.calls.filter(
        ([event]) => (event as { eventName: string }).eventName === "cook_mode_completed"
      )
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the touch hints once on touch screens", () => {
    mockPointer(true);
    render(<Harness />);
    openCookMode();

    expect(screen.getByText("Tap the sides to move through steps.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(localStorage.getItem("linkdish:web:cook-mode-hints-seen:v1")).toBe("true");
    expect(screen.queryByText("Tap the sides to move through steps.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    openCookMode();
    expect(screen.queryByText("Tap the sides to move through steps.")).not.toBeInTheDocument();
  });

  it("offers timers for step durations but not for oven temperatures", () => {
    render(
      <Harness
        recipe={{
          ...recipe,
          steps: [
            { index: 1, text: "Bake until set, 30–35 minutes." },
            { index: 2, text: "Heat the oven to 350°F." }
          ]
        }}
      />
    );
    openCookMode();

    fireEvent.click(screen.getByRole("button", { name: "Start 30–35 min timer" }));
    expect(getKitchenTimers()).toEqual([
      expect.objectContaining({ durationMs: 30 * 60_000, label: "30–35 min", stepIndex: 0 })
    ]);
    // The chip counts down with the dock instead of a static "Running".
    const chip = screen.getByRole("button", { name: "Pause 30–35 min timer" });
    expect(chip).toHaveTextContent("30:00left");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(chip).toHaveTextContent("29:58left");

    // A second tap pauses it (never a duplicate timer), a third resumes.
    fireEvent.click(chip);
    expect(getKitchenTimers()).toHaveLength(1);
    expect(getKitchenTimers()[0]?.paused).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Resume 30–35 min timer" }));
    expect(getKitchenTimers()).toHaveLength(1);
    expect(getKitchenTimers()[0]?.paused).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    settle();
    expect(screen.getByText("Heat the oven to 350°F.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /350/ })).not.toBeInTheDocument();
  });

  it("keeps timers running after cook mode closes", () => {
    render(<Harness recipe={{ ...recipe, steps: [{ index: 1, text: "Rest for 1 minute." }] }} />);
    openCookMode();
    fireEvent.click(screen.getByRole("button", { name: "Start 1 min timer" }));
    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));

    expect(screen.queryByRole("dialog", { name: /Cooking mode/ })).not.toBeInTheDocument();
    expect(getKitchenTimers()).toHaveLength(1);
  });

  it("moves with the arrow keys, but not while typing", () => {
    const onClose = vi.fn();
    render(<CookMode onClose={onClose} onLogCook={vi.fn()} open recipe={recipe} />);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    settle();
    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    settle();
    const note = screen.getByLabelText(/Anything to remember next time/);
    note.focus();
    fireEvent.keyDown(note, { key: "ArrowLeft" });
    settle();
    expect(screen.getByText("Bon appétit!")).toBeInTheDocument();

    fireEvent.keyDown(note, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Close cooking mode" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("offers to resume at the saved step and remembers new steps", async () => {
    const saved = saveCookSession({
      checkedIngredients: ["0:1 cup flour"],
      recipeId: "r1",
      scale: 1,
      stepIndex: 1,
      timers: []
    });
    await flushAsync();
    await saved;
    render(<Harness sessionKey="r1" />);
    await flushAsync();
    openCookMode();
    await flushAsync();

    expect(
      screen.getByRole("heading", { name: "Pick up where you left off?" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume at step 2" }));
    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    openCookMode();
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByText("Whisk the dry ingredients.")).toBeInTheDocument();

    await flushAsync();
    await flushCookSessionWrites();
    expect((await getCookSession("r1"))?.stepIndex).toBe(0);
  });

  it("shares ticked ingredients with the recipe page through the cook session", async () => {
    render(
      <Harness
        recipe={{ ...recipe, steps: [{ index: 1, text: "Whisk the flour and egg until smooth." }] }}
        sessionKey="r2"
      />
    );
    await flushAsync();
    openCookMode();
    await flushAsync();

    const stepPanel = screen.getByText("For this step").parentElement as HTMLElement;
    expect(within(stepPanel).getByRole("checkbox", { name: "1 cup flour" })).toBeInTheDocument();
    expect(within(stepPanel).getByRole("checkbox", { name: "1 egg" })).toBeInTheDocument();
    expect(within(stepPanel).queryByRole("checkbox", { name: "1 tsp baking powder" })).toBeNull();

    fireEvent.click(within(stepPanel).getByRole("checkbox", { name: "1 egg" }));
    expect(within(stepPanel).getByRole("checkbox", { name: "1 egg" })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    await flushAsync();
    await flushCookSessionWrites();
    expect((await getCookSession("r2"))?.checkedIngredients).toEqual(["2:1 egg"]);
  });

  it("gives repeated ingredient lines their own keys", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <CookMode
        onClose={vi.fn()}
        open
        recipe={{
          ...recipe,
          ingredients: [
            { section: "Dough", text: "1 tsp salt" },
            { section: "Sauce", text: "1 tsp salt" }
          ],
          steps: [{ index: 1, text: "Add the salt." }]
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all ingredients" }));
    expect(screen.getAllByRole("checkbox", { name: "1 tsp salt" }).length).toBeGreaterThan(1);
    expect(consoleError.mock.calls.some(([message]) => String(message).includes("same key"))).toBe(
      false
    );
    consoleError.mockRestore();
  });

  it("turns the page on deliberate swipes only, ignoring the synthetic click", () => {
    render(<CookMode onClose={vi.fn()} open recipe={recipe} />);
    const stepArea = document.querySelector<HTMLElement>(".cook-mode-step-area")!;

    // Mostly vertical: a scroll, not a swipe.
    fireEvent.touchStart(stepArea, { changedTouches: [{ pageX: 220, pageY: 120 }] });
    fireEvent.touchMove(stepArea, { changedTouches: [{ pageX: 178, pageY: 170 }] });
    fireEvent.touchEnd(stepArea, { changedTouches: [{ pageX: 178, pageY: 170 }] });
    fireEvent.click(stepArea, { clientX: 350 });
    expect(screen.getByText("Whisk the dry ingredients.")).toBeInTheDocument();

    fireEvent.touchStart(stepArea, { changedTouches: [{ pageX: 220, pageY: 120 }] });
    fireEvent.touchMove(stepArea, { changedTouches: [{ pageX: 170, pageY: 130 }] });
    fireEvent.touchEnd(stepArea, { changedTouches: [{ pageX: 170, pageY: 130 }] });
    fireEvent.click(stepArea, { clientX: 350 });
    settle();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.queryByText("Bon appétit!")).not.toBeInTheDocument();
  });

  it("turns the page from side taps once, ignoring rapid repeats", () => {
    render(<CookMode onClose={vi.fn()} open recipe={recipe} />);
    const stepArea = document.querySelector<HTMLElement>(".cook-mode-step-area")!;
    vi.spyOn(stepArea, "getBoundingClientRect").mockReturnValue({
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

    fireEvent.click(stepArea, { clientX: 350 });
    fireEvent.click(stepArea, { clientX: 350 });
    fireEvent.click(stepArea, { clientX: 350 });
    settle();

    expect(screen.getByText("Mix in the wet ingredients.")).toBeInTheDocument();
    expect(screen.queryByText("Bon appétit!")).not.toBeInTheDocument();
  });

  it("announces each new step from one live region that outlives the step card", () => {
    render(<CookMode onClose={vi.fn()} open recipe={recipe} />);
    const dialog = screen.getByRole("dialog", { name: "Cooking mode for Pancakes" });
    const live = dialog.querySelector<HTMLElement>("[aria-live='polite']");

    expect(live).not.toBeNull();
    expect(live?.closest(".cook-step-card")).toBeNull();
    expect(live).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    settle();

    expect(dialog.querySelector("[aria-live='polite']")).toBe(live);
    expect(live).toHaveTextContent("Step 2 of 2. Mix in the wet ingredients.");

    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    settle();
    expect(live).toHaveTextContent("All done.");
  });

  it("never drops keyboard focus when Previous reaches step 1 or Finish is pressed", () => {
    render(<CookMode onClose={vi.fn()} open recipe={recipe} />);

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    settle();
    const previous = screen.getByRole("button", { name: "Previous step" });
    previous.focus();
    fireEvent.click(previous);
    settle();

    expect(screen.getByText("Whisk the dry ingredients.")).toBeInTheDocument();
    expect(previous).toBeInTheDocument();
    expect(previous).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    settle();
    const finish = screen.getByRole("button", { name: "Finish cooking" });
    finish.focus();
    fireEvent.click(finish);
    settle();

    expect(screen.getByRole("heading", { name: "Bon appétit!" })).toHaveFocus();
  });

  it("hosts the kitchen timer dock inside the dialog while cooking", () => {
    render(
      <MemoryRouter>
        <TimerDock />
        <Harness recipe={{ ...recipe, steps: [{ index: 1, text: "Rest for 10 minutes." }] }} />
      </MemoryRouter>
    );
    openCookMode();
    fireEvent.click(screen.getByRole("button", { name: "Start 10 min timer" }));

    const dialog = screen.getByRole("dialog", { name: "Cooking mode for Pancakes" });
    // Inside the dialog, so the focus trap and aria-modal include the dock's controls.
    const hostedDock = within(dialog).getByRole("complementary", { name: "Kitchen timers" });
    expect(within(hostedDock).getByRole("button", { name: "Pause 10 min timer" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    const dock = screen.getByRole("complementary", { name: "Kitchen timers" });
    expect(dock.closest("[role='dialog']")).toBeNull();
    expect(within(dock).getByRole("button", { name: "Cancel 10 min timer" })).toBeInTheDocument();
  });

  it("traps focus and gives it back to the button that opened it", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Start cooking" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Cooking mode for Pancakes" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close cooking mode" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("logs the cook with a note from the finish screen", async () => {
    const onLogCook = vi.fn().mockResolvedValue(undefined);
    const onRate = vi.fn();
    const onClose = vi.fn();
    render(
      <CookMode
        onClose={onClose}
        onLogCook={onLogCook}
        onRate={onRate}
        open
        rating={null}
        recipe={{ ...recipe, steps: [{ index: 1, text: "Serve." }] }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish cooking" }));
    fireEvent.click(screen.getByRole("radio", { name: "4 stars" }));
    expect(onRate).toHaveBeenCalledWith(4);

    fireEvent.change(screen.getByLabelText(/Anything to remember next time/), {
      target: { value: "  More lemon  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "Log this cook" }));
    await flushAsync();

    expect(onLogCook).toHaveBeenCalledWith({ note: "More lemon" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the screen awake and asks again after the page was hidden", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const sentinels: Array<{ released: boolean; release: typeof release }> = [];
    const request = vi.fn(() => {
      const sentinel = { release, released: false };
      sentinels.push(sentinel);
      return Promise.resolve(sentinel);
    });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });

    render(<CookMode onClose={vi.fn()} open recipe={recipe} />);
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(1);

    // The browser drops the lock when the tab is hidden…
    sentinels[0]!.released = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushAsync();
    expect(request).toHaveBeenCalledTimes(2);

    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
  });
});
