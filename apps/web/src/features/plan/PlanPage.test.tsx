import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { addDaysToDateKey, getWeekStartDateKey, toDateKey } from "../../data/date-keys";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { getMealPlanEntries, resetMealPlanStoreForTests } from "../../data/meal-plan-store";
import {
  PREFERENCES_STORAGE_KEY,
  resetPreferencesForTests
} from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { getShoppingItems, resetShoppingListStoreForTests } from "../shopping/shopping-list-store";
import { resetShoppingSyncForTests } from "../shopping/shopping-sync";

import { getDayLabel } from "./plan-utils";
import { PlanPage } from "./PlanPage";
import { makePlanEntry, makeSavedRecipe, seedPlannerData } from "./testing/plan-fixtures";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({ trackWebEvent: analyticsMocks.trackWebEvent }));
vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: { getHousehold: vi.fn(), getShoppingList: vi.fn(), upsertShoppingItems: vi.fn() }
}));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: false, loading: false, user: null })
}));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const today = toDateKey();
const mondayStart = getWeekStartDateKey(today, 1);

const pasta = makeSavedRecipe("pasta", "Weeknight Pasta", {
  favorite: true,
  ingredients: ["1 lb spaghetti", "2 cups tomato sauce", "1 onion", "salt to taste"],
  servings: "4 servings"
});
const soup = makeSavedRecipe("soup", "Lentil Soup", {
  ingredients: ["1 cup lentils", "1 onion", "4 cups water"],
  servings: "2 servings",
  timesCooked: 3
});

const renderPlan = (path = "/plan") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <PlanPage />
      </ToastProvider>
    </MemoryRouter>
  );

const dayList = () => screen.getByRole("list", { name: /week|Week of/ });
const dayItem = (key: string) =>
  within(dayList())
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(getDayLabel(key).long)) as HTMLElement;

describe("PlanPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ weekStartsOn: 1 }));
    resetPreferencesForTests();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
    resetLibraryStoreForTests();
    resetMealPlanStoreForTests();
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    analyticsMocks.trackWebEvent.mockReset();
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    resetShoppingSyncForTests();
  });

  it("shows the editorial header and a seven-day week starting on the preferred day", async () => {
    renderPlan();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("This week");
    const days = within(screen.getByRole("list", { name: "This week" })).getAllByRole("listitem");
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveTextContent(getDayLabel(mondayStart).weekday);
    expect(within(dayItem(today)).getByText("Today")).toBeInTheDocument();
    await screen.findByText(/nothing planned yet/);
  });

  it("starts the week on Sunday when that is the preference", () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ weekStartsOn: 0 }));
    resetPreferencesForTests();
    renderPlan();

    const firstDay = within(screen.getByRole("list", { name: "This week" })).getAllByRole(
      "listitem"
    )[0];
    expect(firstDay).toHaveTextContent(getDayLabel(getWeekStartDateKey(today, 0)).weekday);
  });

  it("moves between weeks and back to this one", async () => {
    renderPlan();

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Next week");
    expect(dayItem(addDaysToDateKey(mondayStart, 7))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Last week");

    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("This week");
  });

  it("plans a recipe from the cookbook with servings", async () => {
    await seedPlannerData({ recipes: [pasta, soup] });
    renderPlan();

    fireEvent.click(
      screen.getByRole("button", { name: `Add a meal to ${getDayLabel(today).long}` })
    );
    const picker = await screen.findByRole("dialog", { name: "Plan dinner" });
    const recipes = await within(picker).findByRole("radiogroup", { name: "Recipes" });
    expect(within(recipes).getAllByRole("radio")[0]).toHaveTextContent("Weeknight Pasta");
    fireEvent.click(within(picker).getByRole("radio", { name: /Lentil Soup/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "Increase servings" }));
    fireEvent.click(within(picker).getByRole("button", { name: /^Add to/ }));

    await waitFor(() =>
      expect(within(dayItem(today)).getByText("Lentil Soup")).toBeInTheDocument()
    );
    const [entry] = await getMealPlanEntries();
    expect(entry).toMatchObject({ date: today, recipeId: "soup", servings: 3, slot: "dinner" });
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "meal_plan_entry_added",
        properties: { kind: "recipe", slot: "dinner", source: "picker" }
      })
    );
  });

  it("adds a quick note such as leftovers", async () => {
    await seedPlannerData({ recipes: [pasta] });
    renderPlan();

    fireEvent.click(
      screen.getByRole("button", { name: `Add a meal to ${getDayLabel(today).long}` })
    );
    const picker = await screen.findByRole("dialog", { name: "Plan dinner" });
    fireEvent.click(within(picker).getByRole("radio", { name: "Lunch" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Leftovers" }));

    await waitFor(() => expect(within(dayItem(today)).getByText("Leftovers")).toBeInTheDocument());
    expect(within(dayItem(today)).getByText("Lunch")).toBeInTheDocument();
  });

  it("moves, duplicates and removes a meal from its menu, with Undo", async () => {
    await seedPlannerData({
      entries: [makePlanEntry({ date: mondayStart, recipeId: "pasta", title: "Weeknight Pasta" })],
      recipes: [pasta]
    });
    const friday = addDaysToDateKey(mondayStart, 4);
    renderPlan();

    fireEvent.click(await screen.findByRole("button", { name: "Options for Weeknight Pasta" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    const mover = await screen.findByRole("dialog", { name: "Move to…" });
    fireEvent.click(
      within(mover).getByRole("button", { name: new RegExp(getDayLabel(friday).long) })
    );

    await waitFor(() =>
      expect(within(dayItem(friday)).getByText("Weeknight Pasta")).toBeInTheDocument()
    );
    expect(within(dayItem(mondayStart)).queryByText("Weeknight Pasta")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Options for Weeknight Pasta" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate to…" }));
    const duplicator = await screen.findByRole("dialog", { name: "Duplicate to…" });
    fireEvent.click(
      within(duplicator).getByRole("button", { name: new RegExp(getDayLabel(mondayStart).long) })
    );
    await waitFor(async () => expect(await getMealPlanEntries()).toHaveLength(2));

    const [first] = screen.getAllByRole("button", { name: "Options for Weeknight Pasta" });
    fireEvent.click(first as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(async () => expect(await getMealPlanEntries()).toHaveLength(1));
    const removedToast = (await screen.findByText("Removed Weeknight Pasta")).closest(".toast");
    fireEvent.click(within(removedToast as HTMLElement).getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect(await getMealPlanEntries()).toHaveLength(2));
  });

  it("plans dinner in two minutes from favorites on an empty week", async () => {
    await seedPlannerData({ recipes: [pasta, soup] });
    const nextWeek = addDaysToDateKey(mondayStart, 7);
    renderPlan(`/plan?week=${nextWeek}`);

    const quickStart = await screen.findByRole("region", { name: "Your week is wide open" });
    fireEvent.click(within(quickStart).getByRole("button", { name: /Weeknight Pasta/ }));

    await waitFor(async () =>
      expect(await getMealPlanEntries()).toEqual([
        expect.objectContaining({ date: nextWeek, recipeId: "pasta", servings: 4, slot: "dinner" })
      ])
    );
    const keepGoing = await screen.findByRole("region", { name: "Nice. Keep going?" });
    expect(within(keepGoing).queryByRole("button", { name: /Weeknight Pasta/ })).toBeNull();
    fireEvent.click(within(keepGoing).getByRole("button", { name: /Lentil Soup/ }));

    await waitFor(async () =>
      expect((await getMealPlanEntries()).map((entry) => entry.date)).toEqual([
        nextWeek,
        addDaysToDateKey(nextWeek, 1)
      ])
    );
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "meal_plan_entry_added",
        properties: { kind: "recipe", slot: "dinner", source: "quick_start" }
      })
    );
  });

  it("turns the week into one merged shopping list", async () => {
    await seedPlannerData({
      entries: [
        makePlanEntry({
          date: mondayStart,
          recipeId: "pasta",
          servings: 8,
          title: "Weeknight Pasta"
        }),
        makePlanEntry({
          date: addDaysToDateKey(mondayStart, 1),
          recipeId: "soup",
          title: "Lentil Soup"
        }),
        makePlanEntry({ date: addDaysToDateKey(mondayStart, 2), title: "Eat out" })
      ],
      recipes: [pasta, soup]
    });
    renderPlan();

    fireEvent.click(await screen.findByRole("button", { name: "Add to shopping list" }));
    const sheet = await screen.findByRole("dialog", { name: "Shop for the week" });
    expect(within(sheet).getByText(/1 meal has no recipe/)).toBeInTheDocument();
    expect(within(sheet).getByRole("checkbox", { name: /3 onions/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("checkbox", { name: /2 lb spaghetti/ })).toBeInTheDocument();
    expect(within(sheet).getByRole("checkbox", { name: /salt/ })).toHaveAttribute(
      "aria-checked",
      "false"
    );

    fireEvent.click(within(sheet).getByRole("button", { name: /^Add \d+ items$/ }));

    await waitFor(async () => expect(await getShoppingItems()).not.toHaveLength(0));
    const items = await getShoppingItems();
    expect(items.find((item) => item.text === "onions")).toMatchObject({
      qty: 3,
      recipeTitles: ["Weeknight Pasta", "Lentil Soup"]
    });
    expect(items.some((item) => item.text === "salt")).toBe(false);
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "meal_plan_shopping_generated" })
    );
  });
});
