import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetPreferencesForTests } from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { AddRecipeToShoppingSheet } from "./AddRecipeToShoppingSheet";
import {
  addShoppingItems,
  getShoppingItems,
  resetShoppingListStoreForTests
} from "./shopping-list-store";
import { resetShoppingSyncForTests } from "./shopping-sync";

import type { Recipe } from "@linkdish/recipe-domain";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({ trackWebEvent: analyticsMocks.trackWebEvent }));
vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: { getHousehold: vi.fn(), getShoppingList: vi.fn(), upsertShoppingItems: vi.fn() }
}));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const recipe = {
  ingredients: [
    { text: "1 lb ground beef" },
    { section: "Toppings", text: "2 cups shredded lettuce" },
    { section: "Toppings", text: "1 cup cheese" },
    { section: "Sauce", text: "1 cup cheese" },
    { section: "Sauce", text: "salt to taste" }
  ],
  servings: "4 servings",
  title: "Tacos"
} as unknown as Recipe;

const renderSheet = (
  props: Partial<React.ComponentProps<typeof AddRecipeToShoppingSheet>> = {}
) => {
  const onAdded = vi.fn();
  const onClose = vi.fn();

  render(
    <MemoryRouter>
      <ToastProvider>
        <AddRecipeToShoppingSheet
          canSync={false}
          onAdded={onAdded}
          onClose={onClose}
          recipe={recipe}
          recipeId="recipe-tacos"
          {...props}
        />
      </ToastProvider>
    </MemoryRouter>
  );

  return { onAdded, onClose };
};

describe("AddRecipeToShoppingSheet", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    resetPreferencesForTests();
    analyticsMocks.trackWebEvent.mockReset();
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  it("leaves pantry staples unticked and lets you bring them back", () => {
    renderSheet();

    const dialog = screen.getByRole("dialog", { name: "Add ingredients" });
    expect(within(dialog).getByRole("checkbox", { name: /salt/ })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.getByRole("button", { name: "Add 4 items" })).toBeEnabled();

    fireEvent.click(screen.getByRole("switch", { name: "Include pantry staples" }));
    expect(screen.getByRole("button", { name: "Add 5 items" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByRole("button", { name: "Pick some items" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Add 5 items" })).toBeInTheDocument();
  });

  it("keeps identical lines in different sections independent", () => {
    renderSheet();

    const cheese = screen.getAllByRole("checkbox", { name: /1 cup cheese/ });
    expect(cheese).toHaveLength(2);
    fireEvent.click(cheese[0] as HTMLElement);

    expect(cheese[0]).toHaveAttribute("aria-checked", "false");
    expect(cheese[1]).toHaveAttribute("aria-checked", "true");
  });

  it("scales by servings and adds merged items with the recipe attached", async () => {
    const { onAdded, onClose } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    expect(screen.getByRole("checkbox", { name: /2 lb ground beef/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add 4 items" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdded).toHaveBeenCalledWith(4);
    const items = await getShoppingItems();
    expect(items.map((item) => [item.qty, item.unit ?? null, item.text])).toEqual([
      [2, "lb", "ground beef"],
      [4, "cup", "shredded lettuce"],
      [4, "cup", "cheese"]
    ]);
    expect(items[0]).toMatchObject({ recipeId: "recipe-tacos", recipeTitle: "Tacos" });
    expect(await screen.findByText("Added 4 items to your list")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View list" })).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "shopping_item_added",
        properties: { count: 4, method: "recipe_sheet", source: "recipe" }
      })
    );
  });

  it("marks what is already on the list", async () => {
    await addShoppingItems([{ text: "ground beef" }], { canSync: false });
    renderSheet();

    const beef = await screen.findByRole("checkbox", { name: /ground beef/ });
    await waitFor(() => expect(within(beef).getByText("On your list")).toBeInTheDocument());
  });

  it("shows a friendly error and stays open when saving fails", async () => {
    await getShoppingItems();
    fakeIdb.failNextPut("shoppingItems", new Error("QuotaExceededError"));
    const { onAdded, onClose } = renderSheet();

    fireEvent.click(screen.getByRole("button", { name: "Add 4 items" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't update your shopping list. Please try again."
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add 4 items" })).toBeEnabled();
  });
});
