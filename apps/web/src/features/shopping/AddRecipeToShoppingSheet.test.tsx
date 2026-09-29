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
  putShoppingItems,
  resetShoppingListStoreForTests
} from "./shopping-list-store";
import {
  getShoppingSyncState,
  resetShoppingSyncForTests,
  setShoppingAccount,
  SHOPPING_HOUSEHOLD_CACHE_KEY,
  syncShoppingNow
} from "./shopping-sync";

import type { UpsertShoppingItemsRequest } from "@linkdish/api-contracts";
import type { Recipe, ShoppingItem } from "@linkdish/recipe-domain";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));
const apiMocks = vi.hoisted(() => ({
  deleteShoppingItems: vi.fn(),
  getHousehold: vi.fn(),
  getShoppingList: vi.fn(),
  upsertShoppingItems: vi.fn()
}));

vi.mock("../../analytics/client", () => ({ trackWebEvent: analyticsMocks.trackWebEvent }));
vi.mock("../../api/client", () => ({ apiBaseUrl: "/api", apiClient: apiMocks }));
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
    window.sessionStorage.clear();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    resetPreferencesForTests();
    analyticsMocks.trackWebEvent.mockReset();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
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

  it("waits for the household check so the recipe adds up with that household's list", async () => {
    // u1 (household h1) used this device: h1's cheese is on it, and the cache is u1's.
    window.localStorage.setItem(
      SHOPPING_HOUSEHOLD_CACHE_KEY,
      JSON.stringify({ checkedAt: Date.now(), household: true, householdId: "h1", userId: "u1" })
    );
    await putShoppingItems([
      {
        addedBy: "u1",
        checked: false,
        checkedBy: null,
        createdAt: "2026-07-04T10:00:00.000Z",
        id: "cheese-h1",
        qty: 1,
        sync: { householdId: "h1", lastSyncedAt: "2026-07-04T10:00:00.000Z", status: "synced" },
        text: "cheese",
        unit: "cup",
        updatedAt: "2026-07-04T10:00:00.000Z"
      }
    ]);
    const server = new Map<string, ShoppingItem>([
      [
        "cheese-h1",
        {
          addedBy: "u1",
          checked: false,
          id: "cheese-h1",
          qty: 1,
          text: "cheese",
          unit: "cup",
          updatedAt: "2026-07-04T10:00:00.000Z"
        }
      ]
    ]);
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      input.items.forEach((item) => server.set(item.id, item));
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockImplementation(() =>
      Promise.resolve({ items: [...server.values()] })
    );
    let answerHousehold: (value: { household: { id: string } }) => void = () => undefined;
    apiMocks.getHousehold.mockReturnValue(
      new Promise((resolve) => {
        answerHousehold = resolve;
      })
    );

    // u2, also in h1, signs in here for the first time. The page knows u2 shares a list; the
    // sync layer's own check is still out.
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u2" });
    const { onClose } = renderSheet({ canSync: true, userId: "u2" });
    fireEvent.click(screen.getByRole("button", { name: "Add 4 items" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).not.toHaveBeenCalled();

    answerHousehold({ household: { id: "h1" } });
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // The cheese adds up with h1's instead of going on the list twice.
    await waitFor(async () =>
      expect(
        (await getShoppingItems())
          .filter((item) => item.text === "cheese")
          .map((item) => [item.id, item.qty, item.sync.householdId])
      ).toEqual([["cheese-h1", 3, "h1"]])
    );
    await waitFor(() =>
      expect([...server.values()].filter((item) => item.text === "cheese")).toEqual([
        expect.objectContaining({ id: "cheese-h1", qty: 3 })
      ])
    );
  });

  it("records the household on items added before its check answers", async () => {
    let answerHousehold: (value: { household: { id: string } }) => void = () => undefined;
    apiMocks.getHousehold.mockReturnValueOnce(
      new Promise((resolve) => {
        answerHousehold = resolve;
      })
    );
    const pushes: Array<{ household: string; ids: string[] }> = [];
    let serverHousehold = "h1";
    apiMocks.upsertShoppingItems.mockImplementation((input: UpsertShoppingItemsRequest) => {
      pushes.push({ household: serverHousehold, ids: input.items.map((item) => item.id) });
      return Promise.resolve({ ignored: [], items: input.items });
    });
    apiMocks.getShoppingList.mockResolvedValue({ items: [] });
    // The page knows this account shares a list; the sync layer's own check is still out.
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u1" });
    const { onClose } = renderSheet({ canSync: true, userId: "u1" });

    // Added at once, for the household list.
    fireEvent.click(screen.getByRole("button", { name: "Add 4 items" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((await getShoppingItems()).map((item) => item.sync.status)).toEqual([
      "dirty",
      "dirty",
      "dirty"
    ]);

    // Once the check answers, they are h1's.
    answerHousehold({ household: { id: "h1" } });
    await waitFor(async () =>
      expect((await getShoppingItems()).map((item) => item.sync.householdId)).toEqual([
        "h1",
        "h1",
        "h1"
      ])
    );

    // u1 signs out before they were sent; u2 (household h2) signs in and syncs.
    setShoppingAccount({ isAuthenticated: false, loading: false });
    serverHousehold = "h2";
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "h2" } });
    setShoppingAccount({ isAuthenticated: true, loading: false, userId: "u2" });
    await waitFor(() => expect(getShoppingSyncState().householdId).toBe("h2"));
    await syncShoppingNow();

    expect(getShoppingSyncState().phase).toBe("synced");
    expect(pushes.filter((push) => push.household === "h2")).toEqual([]);
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
