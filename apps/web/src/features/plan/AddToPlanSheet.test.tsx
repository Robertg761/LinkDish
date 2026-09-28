import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { addDaysToDateKey, toDateKey } from "../../data/date-keys";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { getMealPlanEntries, resetMealPlanStoreForTests } from "../../data/meal-plan-store";
import { resetPreferencesForTests } from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { AddToPlanSheet } from "./AddToPlanSheet";
import { getDayLabel } from "./plan-utils";
import { makePlanEntry, makeSavedRecipe, seedPlannerData } from "./testing/plan-fixtures";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({ trackWebEvent: analyticsMocks.trackWebEvent }));
vi.mock("../../api/client", () => ({ apiBaseUrl: "/api", apiClient: {} }));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const today = toDateKey();

describe("AddToPlanSheet", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPreferencesForTests();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    resetLibraryStoreForTests();
    resetMealPlanStoreForTests();
    analyticsMocks.trackWebEvent.mockReset();
  });

  it("plans a recipe on one of the next 14 days with a meal and servings", async () => {
    const inThreeDays = addDaysToDateKey(today, 3);
    await seedPlannerData({
      entries: [makePlanEntry({ date: inThreeDays, title: "Leftovers" })],
      recipes: [makeSavedRecipe("pasta", "Weeknight Pasta", { servings: "Serves 6" })]
    });
    const onAdded = vi.fn();
    const onClose = vi.fn();

    render(
      <MemoryRouter>
        <ToastProvider>
          <AddToPlanSheet
            onAdded={onAdded}
            onClose={onClose}
            open
            recipeId="pasta"
            recipeTitle="Weeknight Pasta"
          />
        </ToastProvider>
      </MemoryRouter>
    );

    const sheet = screen.getByRole("dialog", { name: "Add to your plan" });
    const days = within(sheet).getByRole("radiogroup", { name: "Day" });
    expect(within(days).getAllByRole("radio")).toHaveLength(14);
    expect(within(days).getAllByRole("radio")[0]).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(
        within(days).getByRole("radio", {
          name: new RegExp(`${getDayLabel(inThreeDays).long}, has meals planned`)
        })
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(within(sheet).getByRole("spinbutton", { name: "Servings" })).toHaveTextContent("6")
    );

    fireEvent.click(
      within(days).getByRole("radio", { name: new RegExp(getDayLabel(inThreeDays).long) })
    );
    fireEvent.click(within(sheet).getByRole("radio", { name: "Lunch" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Decrease servings" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Add to plan" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const entries = await getMealPlanEntries();
    expect(entries.find((entry) => entry.recipeId === "pasta")).toMatchObject({
      date: inThreeDays,
      servings: 5,
      slot: "lunch",
      title: "Weeknight Pasta"
    });
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ recipeId: "pasta" }));
    expect(await screen.findByRole("button", { name: "View plan" })).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "meal_plan_entry_added",
        properties: { kind: "recipe", slot: "lunch", source: "recipe_page" }
      })
    );
  });
});
