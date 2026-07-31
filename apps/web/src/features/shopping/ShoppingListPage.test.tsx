import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShoppingListPage } from "./ShoppingListPage";

import type * as ShoppingListStore from "./shopping-list-store";

const storeMocks = vi.hoisted(() => ({
  addShoppingItems: vi.fn(),
  deleteShoppingItem: vi.fn(),
  getShoppingItems: vi.fn(),
  setShoppingItemChecked: vi.fn(),
  syncShoppingItems: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    getHousehold: vi.fn()
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: false,
    loading: false,
    user: null
  })
}));

vi.mock("./shopping-list-store", async (importOriginal) => {
  const actual = await importOriginal<typeof ShoppingListStore>();

  return {
    ...actual,
    addShoppingItems: storeMocks.addShoppingItems,
    deleteShoppingItem: storeMocks.deleteShoppingItem,
    getShoppingItems: storeMocks.getShoppingItems,
    setShoppingItemChecked: storeMocks.setShoppingItemChecked,
    syncShoppingItems: storeMocks.syncShoppingItems
  };
});

describe("ShoppingListPage", () => {
  beforeEach(() => {
    storeMocks.addShoppingItems.mockReset();
    storeMocks.deleteShoppingItem.mockReset();
    storeMocks.getShoppingItems.mockReset();
    storeMocks.getShoppingItems.mockResolvedValue([]);
    storeMocks.setShoppingItemChecked.mockReset();
    storeMocks.syncShoppingItems.mockReset();
  });

  it("shows a first-class empty state before items exist", async () => {
    render(<ShoppingListPage />);

    expect(
      await screen.findByText("Your shopping list is empty. Add ingredients from any recipe.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Your loose items will live here.")).not.toBeInTheDocument();
  });
});
