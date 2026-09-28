import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { requestCommandPalette } from "../../lib/command-palette-events";
import { getPreferences, resetPreferencesForTests } from "../../preferences/preferences-store";

import { CommandCenter } from "./CommandCenter";

import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type * as ShoppingListStore from "../shopping/shopping-list-store";

const analyticsMocks = vi.hoisted(() => ({ trackWebError: vi.fn(), trackWebEvent: vi.fn() }));
vi.mock("../../analytics/client", () => analyticsMocks);

const libraryMocks = vi.hoisted(() => ({ recipes: [] as WebSavedRecipe[] }));
vi.mock("../../data/library-store", () => ({
  useSavedRecipes: () => ({
    error: null,
    recipes: libraryMocks.recipes,
    retry: vi.fn(),
    status: "ready"
  })
}));

const shoppingMocks = vi.hoisted(() => ({
  addParsedShoppingItems: vi.fn(),
  requestShoppingSync: vi.fn(),
  useShoppingAccount: vi.fn()
}));
vi.mock("../shopping/shopping-list-store", async (importOriginal) => ({
  ...(await importOriginal<typeof ShoppingListStore>()),
  addParsedShoppingItems: shoppingMocks.addParsedShoppingItems
}));
vi.mock("../shopping/shopping-sync", () => ({
  getShoppingWriteOptions: () => ({ canSync: false }),
  requestShoppingSync: shoppingMocks.requestShoppingSync,
  useShoppingAccount: shoppingMocks.useShoppingAccount
}));

const recipe = (id: string, title: string, extra: Partial<WebSavedRecipe> = {}): WebSavedRecipe =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    id,
    recipe: {
      cookTimeMinutes: 20,
      image: null,
      ingredients: [{ text: "2 lemons" }, { text: "4 chicken thighs" }],
      nutrition: null,
      prepTimeMinutes: 10,
      servings: "4",
      sourceType: "recipe-webpage",
      sourceUrl: `https://www.bonappetit.com/${id}`,
      steps: [{ index: 1, text: "Roast everything." }],
      title
    },
    sourceHost: "bonappetit.com",
    sourceUrl: `https://www.bonappetit.com/${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...extra
  }) as unknown as WebSavedRecipe;

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderCenter = (path = "/", page: React.ReactNode = null) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <main id="main-content">{page}</main>
        <button type="button">Somewhere on the page</button>
        <CommandCenter />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>
  );

const pressPalette = () => {
  fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
};

const openPalette = async () => {
  pressPalette();
  return screen.findByRole("combobox", { name: "Search recipes, pages and actions" });
};

const activeOption = (input: HTMLElement) => {
  const id = input.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

const location = () => screen.getByTestId("location").textContent;

const lastPaletteEvent = () =>
  (
    analyticsMocks.trackWebEvent.mock.calls as Array<
      [{ eventName: string; properties: Record<string, unknown> }]
    >
  )
    .map(([event]) => event)
    .filter((event) => event.eventName === "command_palette_used")
    .at(-1);

describe("command palette", () => {
  beforeEach(() => {
    resetPreferencesForTests();
    analyticsMocks.trackWebEvent.mockReset();
    shoppingMocks.addParsedShoppingItems
      .mockReset()
      .mockResolvedValue({ changed: [], mergedCount: 0 });
    shoppingMocks.requestShoppingSync.mockReset();
    libraryMocks.recipes = [
      recipe("lemon-chicken", "Weeknight Lemon Chicken", {
        lastOpenedAt: "2026-09-27T10:00:00.000Z"
      }),
      recipe("tomato-soup", "Tomato Soup")
    ];
  });

  afterEach(() => {
    resetPreferencesForTests();
  });

  it("opens with ⌘K as a combobox over a grouped listbox, showing recent recipes", async () => {
    renderCenter();
    const input = await openPalette();
    const dialog = screen.getByRole("dialog", { name: "Search and commands" });
    const listbox = screen.getByRole("listbox");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveFocus();
    expect(within(listbox).getByRole("group", { name: "Recent recipes" })).toBeInTheDocument();
    expect(within(listbox).getByRole("group", { name: "Go to" })).toBeInTheDocument();
    expect(within(listbox).getByRole("group", { name: "Actions" })).toBeInTheDocument();

    const first = activeOption(input);
    expect(first).toHaveAttribute("role", "option");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveTextContent("Weeknight Lemon Chicken");
    expect(first).toHaveTextContent("bonappetit.com · 30 min");
  });

  it("claims ⌘K so the page's own ⌘K handler stands down", async () => {
    renderCenter();
    const seen: boolean[] = [];
    const pageHandler = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", pageHandler);

    pressPalette();
    await screen.findByRole("dialog", { name: "Search and commands" });
    window.removeEventListener("keydown", pageHandler);

    expect(seen).toEqual([true]);
  });

  it("searches recipes with highlighted matches and opens the chosen one", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "lemon" } });
    const option = activeOption(input);

    expect(option).toHaveTextContent("Weeknight Lemon Chicken");
    expect(option?.querySelector("mark")).toHaveTextContent("Lemon");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(location()).toBe("/recipes/lemon-chicken");
    expect(screen.queryByRole("dialog", { name: "Search and commands" })).not.toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "command_palette_used",
        properties: { action: "open_recipe", has_query: true, source: "keyboard" }
      })
    );
  });

  it("starts cooking with Shift+Enter", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

    expect(location()).toBe("/recipes/lemon-chicken?cook=1");
    expect(lastPaletteEvent()?.properties).toMatchObject({ action: "start_cooking" });
  });

  it("moves with the arrow keys and jumps between groups with Tab", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption(input)).toHaveTextContent("Tomato Soup");

    fireEvent.keyDown(input, { key: "Tab" });
    expect(activeOption(input)).toHaveTextContent("Cookbook");

    fireEvent.keyDown(input, { key: "Tab" });
    expect(activeOption(input)).toHaveTextContent("Add a recipe");

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(activeOption(input)).toHaveTextContent("Cookbook");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeOption(input)).toHaveTextContent("Tomato Soup");
    expect(input).toHaveFocus();

    // Wraps from the top to the last option.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeOption(input)).toHaveTextContent("Keyboard shortcuts");
  });

  it("goes to a page from the Go to group", async () => {
    renderCenter("/recipes/lemon-chicken");
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "shopping" } });
    fireEvent.click(screen.getByRole("option", { name: /Shopping list/ }));

    expect(location()).toBe("/shopping");
  });

  it("imports a pasted link", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "https://www.seriouseats.com/best-chili" } });
    expect(activeOption(input)).toHaveTextContent("Import this recipe");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(location()).toBe(
      `/import?url=${encodeURIComponent("https://www.seriouseats.com/best-chili")}`
    );
  });

  it("adds typed text to the shopping list and confirms with a toast", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "oat milk" } });
    fireEvent.click(screen.getByRole("option", { name: /Add “oat milk” to the shopping list/ }));

    await waitFor(() => expect(shoppingMocks.addParsedShoppingItems).toHaveBeenCalled());
    expect(shoppingMocks.addParsedShoppingItems.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ text: "oat milk" })
    ]);
    expect(shoppingMocks.requestShoppingSync).toHaveBeenCalled();
    expect(await screen.findByText("Added “oat milk” to your shopping list")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "shopping_item_added" })
    );
  });

  it("switches the theme", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "dark" } });
    fireEvent.click(screen.getByRole("option", { name: /Switch to dark theme/ }));

    expect(getPreferences().theme).toBe("dark");
  });

  it("closes on Escape and gives focus back", async () => {
    renderCenter();
    const trigger = screen.getByRole("button", { name: "Somewhere on the page" });
    trigger.focus();
    const input = await openPalette();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Search and commands" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("toggles closed with ⌘K and opens from the rail's search button", async () => {
    renderCenter();
    await openPalette();
    pressPalette();
    expect(screen.queryByRole("dialog", { name: "Search and commands" })).not.toBeInTheDocument();

    act(() => {
      requestCommandPalette({ source: "rail_search" });
    });
    const input = await screen.findByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(lastPaletteEvent()?.properties).toMatchObject({ source: "rail_search" });
  });

  it("opens the keyboard shortcuts sheet from the palette", async () => {
    renderCenter();
    const input = await openPalette();

    fireEvent.change(input, { target: { value: "shortcuts" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});

describe("global shortcuts", () => {
  beforeEach(() => {
    libraryMocks.recipes = [];
  });

  it("opens the shortcuts sheet on ?", async () => {
    renderCenter();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Go to Meal plan")).toBeInTheDocument();
  });

  it("navigates with g-sequences and n", () => {
    renderCenter("/settings");

    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "p" });
    expect(location()).toBe("/plan");

    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "s" });
    expect(location()).toBe("/shopping");

    fireEvent.keyDown(document.body, { key: "n" });
    expect(location()).toBe("/import");

    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "c" });
    expect(location()).toBe("/");
  });

  it("ignores letters typed into fields and anything while a dialog is open", () => {
    renderCenter("/settings", <input aria-label="Name" />);
    const field = screen.getByRole("textbox", { name: "Name" });

    fireEvent.keyDown(field, { key: "n" });
    fireEvent.keyDown(field, { key: "g" });
    fireEvent.keyDown(field, { key: "p" });
    expect(location()).toBe("/settings");

    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "n" });
    fireEvent.keyDown(document.body, { ctrlKey: true, key: "k" });
    dialog.remove();

    expect(location()).toBe("/settings");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("leaves / to a page search field, and opens the palette elsewhere", async () => {
    const { unmount } = renderCenter(
      "/",
      <input aria-label="Search your cookbook" type="search" />
    );

    fireEvent.keyDown(document.body, { key: "/" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    unmount();

    renderCenter("/settings");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });
});
