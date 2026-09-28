import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests } from "../../data/change-feed";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { SHOPPING_HIDE_STAPLES_KEY } from "./shopping-format";
import {
  addShoppingItems,
  getShoppingItems,
  resetShoppingListStoreForTests
} from "./shopping-list-store";
import { resetShoppingSyncForTests } from "./shopping-sync";
import { ShoppingListPage } from "./ShoppingListPage";

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({ trackWebEvent: analyticsMocks.trackWebEvent }));
vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    deleteShoppingItems: vi.fn(),
    getHousehold: vi.fn(),
    getShoppingList: vi.fn(),
    upsertShoppingItems: vi.fn()
  }
}));
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: false, loading: false, user: null })
}));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const renderPage = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <ShoppingListPage />
      </ToastProvider>
    </MemoryRouter>
  );

const openMenuItem = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: "List options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
};

const liveTexts = async () => (await getShoppingItems()).map((item) => item.text);

describe("ShoppingListPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    analyticsMocks.trackWebEvent.mockReset();
    // Reduced motion keeps the check-off animation short.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn()
    }));
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    resetShoppingSyncForTests();
  });

  it("shows a warm empty state with a way to a recipe and to the planner", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Your basket is empty" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Shopping list");
    expect(screen.getByRole("link", { name: /add from a recipe/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /plan your week/i })).toHaveAttribute("href", "/plan");
    expect(screen.getByText(/Saved on this device/)).toBeInTheDocument();
  });

  it("groups by aisle in store order with friendly amounts and recipe chips", async () => {
    await addShoppingItems(
      [
        { recipeId: "r1", recipeTitle: "Cookies", text: "2/3 cup brown sugar" },
        { recipeId: "r2", recipeTitle: "Soup", text: "1 onion" }
      ],
      { canSync: false }
    );
    renderPage();

    const produce = await screen.findByRole("region", { name: /produce/i });
    const baking = screen.getByRole("region", { name: /baking/i });
    expect(produce.compareDocumentPosition(baking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(baking).getByRole("checkbox", { name: "⅔ cup brown sugar" })).toBeInTheDocument();
    expect(within(baking).getByText("Cookies")).toBeInTheDocument();
    expect(screen.getByText("2 to buy")).toBeInTheDocument();
  });

  it("adds one item per line when a list is pasted", async () => {
    renderPage();
    const input = await screen.findByRole("textbox", { name: "Add an item" });

    fireEvent.paste(input, {
      clipboardData: { getData: () => "- 2 lemons\n• milk, oat if possible\n\n3 cups rice" }
    });

    await waitFor(async () =>
      expect((await liveTexts()).sort()).toEqual(["lemons", "milk, oat if possible", "rice"])
    );
    expect(await screen.findByText("Added 3 items")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "shopping_item_added",
        properties: { count: 3, method: "paste", source: "manual" }
      })
    );
  });

  it("adds typed items and offers them again as quick adds", async () => {
    renderPage();
    const input = await screen.findByRole("textbox", { name: "Add an item" });

    fireEvent.change(input, { target: { value: "Oat milk" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("checkbox", { name: "Oat milk" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Oat milk" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "In the cart" })).toBeInTheDocument()
    );

    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("button", { name: "Add Oat milk" }));
    await waitFor(async () =>
      expect((await getShoppingItems()).find((item) => item.text === "Oat milk")?.checked).toBe(
        false
      )
    );
  });

  it("checks items off into the cart", async () => {
    await addShoppingItems([{ text: "1 onion" }, { text: "bread" }], { canSync: false });
    renderPage();

    fireEvent.click(await screen.findByRole("checkbox", { name: "1 onion" }));

    const cart = await screen.findByRole("region", { name: "In the cart" });
    expect(within(cart).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("1 to buy · 1 in the cart")).toBeInTheDocument();
    fireEvent.click(within(cart).getByRole("button", { name: /in the cart/i }));
    expect(within(cart).getByRole("checkbox", { name: "1 onion" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "shopping_item_checked",
        properties: { checked: true, source: "manual" }
      })
    );
  });

  it("removes an item with Undo instead of a confirm", async () => {
    await addShoppingItems([{ text: "1 onion" }], { canSync: false });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Remove 1 onion" }));
    expect(await screen.findByText("Removed onion")).toBeInTheDocument();
    await waitFor(async () => expect(await liveTexts()).toEqual([]));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("checkbox", { name: "1 onion" })).toBeInTheDocument();
    expect(await liveTexts()).toEqual(["onion"]);
  });

  it("clears the cart and the whole list, both undoable", async () => {
    await addShoppingItems([{ text: "eggs" }, { text: "jam" }], { canSync: false });
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: "eggs" }));
    await screen.findByRole("region", { name: "In the cart" });

    await openMenuItem("Clear the cart");
    expect(await screen.findByText("Cleared 1 item from the cart")).toBeInTheDocument();
    await waitFor(async () => expect(await liveTexts()).toEqual(["jam"]));

    await openMenuItem("Clear all");
    const dialog = await screen.findByRole("dialog", { name: "Clear the whole list?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" }));
    expect(
      await screen.findByRole("heading", { name: "Your basket is empty" })
    ).toBeInTheDocument();

    expect(screen.getByText("Your list is clear")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("checkbox", { name: "jam" })).toBeInTheDocument();
  });

  it("copies the list as plain text when the share sheet isn't available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await addShoppingItems([{ text: "2 onions" }, { text: "1 cup flour" }], { canSync: false });
    renderPage();
    await screen.findByRole("checkbox", { name: "2 onions" });

    await openMenuItem("Share list");

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Shopping list\n\nProduce\n• 2 onions\n\nBaking\n• 1 cup flour\n"
      )
    );
    expect(await screen.findByText("List copied. Paste it anywhere.")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "shopping_list_shared",
        properties: { item_count: 2, method: "copy" }
      })
    );
  });

  it("hides pantry staples on request and remembers it", async () => {
    await addShoppingItems([{ text: "salt" }, { text: "2 lemons" }], { canSync: false });
    renderPage();
    await screen.findByRole("checkbox", { name: "salt" });

    await openMenuItem(/Hide pantry staples/);

    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "salt" })).toBeNull());
    expect(screen.getByRole("button", { name: /1 staple hidden/i })).toBeInTheDocument();
    expect(window.localStorage.getItem(SHOPPING_HIDE_STAPLES_KEY)).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /1 staple hidden/i }));
    expect(await screen.findByRole("checkbox", { name: "salt" })).toBeInTheDocument();
  });

  it("switches to grouping by recipe", async () => {
    await addShoppingItems(
      [{ recipeId: "r1", recipeTitle: "Chili", text: "1 can beans" }, { text: "paper towels" }],
      { canSync: false }
    );
    renderPage();
    await screen.findByRole("checkbox", { name: "paper towels" });

    fireEvent.click(screen.getByRole("radio", { name: "By recipe" }));

    expect(await screen.findByRole("heading", { name: /Chili/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Added by you/ })).toBeInTheDocument();
  });

  it("edits an item in a sheet", async () => {
    await addShoppingItems([{ text: "1 onion" }], { canSync: false });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit 1 onion" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit item" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Item" }), {
      target: { value: "3 red onions" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("checkbox", { name: "3 red onions" })).toBeInTheDocument();
  });
});
