import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LIBRARY_LINES } from "../../lib/flavor-copy";

import { LibraryPage } from "./LibraryPage";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { SharedRecipe } from "@linkdish/api-contracts";

const apiClientMocks = vi.hoisted(() => ({
  deleteSharedRecipe: vi.fn(),
  ExtractorApiError: class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = "ExtractorApiError";
    }
  },
  getSharedRecipes: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    deleteSharedRecipe: apiClientMocks.deleteSharedRecipe,
    getSharedRecipes: apiClientMocks.getSharedRecipes
  },
  ExtractorApiError: apiClientMocks.ExtractorApiError
}));

const authMocks = vi.hoisted(() => ({
  user: {
    billingPlan: "family",
    email: "owner@example.com",
    id: "user_owner"
  } as { billingPlan?: string; email: string; id: string } | null
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: Boolean(authMocks.user),
    user: authMocks.user
  })
}));

const storeMocks = vi.hoisted(() => ({
  deleteSavedRecipe: vi.fn(),
  duplicateSavedRecipe: vi.fn(),
  getSavedRecipes: vi.fn(),
  getSharedRecipeOwnerLabel: vi.fn(
    (recipe: SharedRecipe) => recipe.ownerDisplayName ?? recipe.ownerEmail
  ),
  getSharedRecipeSourceHost: vi.fn(
    (recipe: SharedRecipe) => new URL(recipe.recipe.sourceUrl).hostname
  ),
  saveSharedRecipeCopy: vi.fn(),
  seedStarterRecipesIfNeeded: vi.fn(),
  syncRecipeToHousehold: vi.fn()
}));

vi.mock("./saved-recipe-store", () => ({
  deleteSavedRecipe: storeMocks.deleteSavedRecipe,
  duplicateSavedRecipe: storeMocks.duplicateSavedRecipe,
  getSavedRecipes: storeMocks.getSavedRecipes,
  getSharedRecipeOwnerLabel: storeMocks.getSharedRecipeOwnerLabel,
  getSharedRecipeSourceHost: storeMocks.getSharedRecipeSourceHost,
  saveSharedRecipeCopy: storeMocks.saveSharedRecipeCopy,
  seedStarterRecipesIfNeeded: storeMocks.seedStarterRecipesIfNeeded,
  syncRecipeToHousehold: storeMocks.syncRecipeToHousehold
}));

const personalRecipe: WebSavedRecipe = {
  createdAt: "2026-06-01T12:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id: "recipe_1",
  recipe: {
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
    ingredients: [{ text: "1 cup rice" }],
    nutrition: null,
    prepTimeMinutes: 5,
    servings: "4 servings",
    sourceType: "recipe-webpage",
    sourceUrl: "https://example.com/rice",
    steps: [{ index: 1, text: "Cook it" }],
    title: "Personal Rice"
  },
  sourceHost: "example.com",
  sourceUrl: "https://example.com/rice",
  sync: {
    status: "local_only"
  },
  updatedAt: "2026-06-01T12:00:00.000Z"
};

const sharedRecipe: SharedRecipe = {
  createdAt: "2026-06-02T12:00:00.000Z",
  fetchMode: "http",
  householdId: "household_1",
  id: "shared_1",
  notes: "Family favorite",
  ownerDisplayName: "Robert",
  ownerEmail: "owner@example.com",
  ownerUserId: "user_owner",
  provenance: ["jsonld"],
  recipe: {
    ...personalRecipe.recipe,
    sourceUrl: "https://family.example.com/chili",
    title: "Family Chili"
  },
  strategy: "recipe-schema",
  updatedAt: "2026-06-03T12:00:00.000Z",
  warnings: []
};

describe("LibraryPage", () => {
  beforeEach(() => {
    localStorage.clear();
    authMocks.user = {
      billingPlan: "family",
      email: "owner@example.com",
      id: "user_owner"
    };
    apiClientMocks.deleteSharedRecipe.mockReset();
    apiClientMocks.getSharedRecipes.mockReset();
    apiClientMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });
    storeMocks.deleteSavedRecipe.mockReset();
    storeMocks.duplicateSavedRecipe.mockReset();
    storeMocks.duplicateSavedRecipe.mockResolvedValue({
      ...personalRecipe,
      id: "recipe_duplicate"
    });
    storeMocks.getSavedRecipes.mockReset();
    storeMocks.getSavedRecipes.mockResolvedValue([personalRecipe]);
    storeMocks.saveSharedRecipeCopy.mockReset();
    storeMocks.saveSharedRecipeCopy.mockResolvedValue({
      ...personalRecipe,
      id: "recipe_copy",
      recipe: {
        ...personalRecipe.recipe,
        title: "Family Chili Copy"
      }
    });
    storeMocks.seedStarterRecipesIfNeeded.mockReset();
    storeMocks.seedStarterRecipesIfNeeded.mockResolvedValue(undefined);
    storeMocks.syncRecipeToHousehold.mockReset();
    storeMocks.syncRecipeToHousehold.mockResolvedValue(personalRecipe);
  });

  it("keeps personal row actions outside recipe links", async () => {
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const titleLink = await screen.findByRole("link", { name: "Personal Rice" });
    expect(titleLink).toHaveAttribute("href", "/recipes/recipe_1");

    const personalRow = titleLink.closest(".recipe-row");
    expect(personalRow?.querySelector(".recipe-row-monogram")).toHaveTextContent("P");

    const removeButton = screen.getByRole("button", { name: "Remove Personal Rice" });
    const duplicateButton = screen.getByRole("button", { name: "Duplicate Personal Rice" });

    expect(removeButton.closest("a")).toBeNull();
    expect(duplicateButton.closest("a")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Personal Rice" })).not.toBeInTheDocument();
  });

  it("uses an inline confirmation group before removing a recipe", async () => {
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const removeButton = await screen.findByRole("button", { name: "Remove Personal Rice" });
    fireEvent.click(removeButton);

    const confirmation = screen.getByRole("group", { name: "Confirm remove Personal Rice" });
    expect(within(confirmation).getByRole("button", { name: "Keep" })).toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("uses the shared flavor-copy list for the empty library headline", async () => {
    apiClientMocks.getSharedRecipes.mockResolvedValue({ recipes: [] });
    storeMocks.getSavedRecipes.mockResolvedValue([]);

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const emptyTitle = await screen.findByRole("heading", { level: 2 });

    expect(EMPTY_LIBRARY_LINES).toContain(emptyTitle.textContent);
    expect(screen.getByRole("link", { name: "Import a Recipe" })).toHaveAttribute(
      "href",
      "/import"
    );
  });

  it("renders extracted servings text without appending a duplicate label", async () => {
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    expect(screen.queryByLabelText("Search Recipes")).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search title, ingredients, method, notes")
    ).toBeInTheDocument();

    const personalRow = (await screen.findByText("Personal Rice")).closest(".recipe-row");
    expect(personalRow).not.toBeNull();
    expect(
      within(personalRow as HTMLElement).getByText("4 servings · Prep 5 min · Cook 20 min")
    ).toBeInTheDocument();
    expect(
      within(personalRow as HTMLElement).queryByText("4 servings servings")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Family" }));

    const familyRow = await screen.findByText("Family Chili");
    const familyRecipeRow = familyRow.closest(".recipe-row");
    expect(familyRecipeRow).not.toBeNull();
    expect(
      within(familyRecipeRow as HTMLElement).getByText("4 servings · Prep 5 min · Cook 20 min")
    ).toBeInTheDocument();
    expect(
      within(familyRecipeRow as HTMLElement).queryByText("4 servings servings")
    ).not.toBeInTheDocument();
  });

  it("renders family recipes from the API without turning them into personal cards", async () => {
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("tab", { name: "Family" }));

    const familyRow = (await screen.findByText("Family Chili")).closest(".recipe-row");
    expect(familyRow).not.toBeNull();
    expect(
      within(familyRow as HTMLElement).getByRole("link", { name: "Family Chili" })
    ).toHaveAttribute("href", "/recipes/shared/shared_1");
    expect(within(familyRow as HTMLElement).getByText("Owned by Robert")).toBeInTheDocument();

    fireEvent.click(
      within(familyRow as HTMLElement).getByRole("button", {
        name: "Save copy of Family Chili"
      })
    );

    await waitFor(() => {
      expect(storeMocks.saveSharedRecipeCopy).toHaveBeenCalledWith(sharedRecipe);
    });
  });

  it("disables the family tab when the account cannot access shared recipes", async () => {
    apiClientMocks.getSharedRecipes.mockRejectedValue(
      new apiClientMocks.ExtractorApiError("Extractor API request failed.", 403, {
        message: "An active LinkDish Family household is required."
      })
    );

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const familyTab = await screen.findByRole("tab", { name: "Family" });

    await waitFor(() => {
      expect(familyTab).not.toBeDisabled();
      expect(familyTab).toHaveAttribute("aria-disabled", "true");
    });
    fireEvent.click(familyTab);
    expect(
      screen.getByText(
        "Family recipe sharing is available after you create or join an active Family household."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Your family recipe book is empty.")).not.toBeInTheDocument();
  });

  it("opens a dismissible sign-in prompt when a signed-out reader chooses Family", async () => {
    authMocks.user = null;

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const familyTab = await screen.findByRole("tab", { name: "Family" });
    expect(familyTab).not.toHaveAttribute("aria-disabled");
    fireEvent.click(familyTab);

    const prompt = screen.getByRole("dialog", { name: "Cook together, in one place." });
    expect(prompt).toHaveAttribute("aria-modal", "true");
    expect(prompt.closest(".library-sign-in-prompt-backdrop")?.parentElement).toBe(document.body);
    expect(within(prompt).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/account"
    );
    expect(screen.getByRole("button", { name: "Sign in to use Family" })).toBeInTheDocument();

    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Cook together, in one place." })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to use Family" }));
    expect(
      screen.getByRole("dialog", { name: "Cook together, in one place." })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Family sign-in prompt" }));
    expect(
      screen.queryByRole("dialog", { name: "Cook together, in one place." })
    ).not.toBeInTheDocument();
  });

  it("keeps the cookbook controls and recipe rows in one centered content column", async () => {
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const content = screen
      .getByRole("heading", { name: "Cookbook", level: 1 })
      .closest(".library-content");
    expect(content).not.toBeNull();
    expect(within(content as HTMLElement).getByRole("tablist")).toBeInTheDocument();
    expect(
      within(content as HTMLElement).getByPlaceholderText(
        "Search title, ingredients, method, notes"
      )
    ).toBeInTheDocument();
    expect(
      within(content as HTMLElement).getByRole("group", { name: "Recipe sort" })
    ).toBeInTheDocument();
    expect((await screen.findByText("Personal Rice")).closest(".recipe-row")).not.toBeNull();
  });

  it("keeps the family tab available when shared recipes fail to load", async () => {
    apiClientMocks.getSharedRecipes.mockRejectedValue(new Error("Network unavailable"));

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const familyTab = await screen.findByRole("tab", { name: "Family" });

    await waitFor(() => {
      expect(familyTab).not.toBeDisabled();
      expect(familyTab).toHaveAttribute("aria-disabled", "false");
    });
    expect(
      screen.getByText("Family recipes could not be loaded. Check your connection and try again.")
    ).toBeInTheDocument();
  });

  it("sorts personal rows from an overlay menu and reverses the selected order", async () => {
    const olderPopularRecipe: WebSavedRecipe = {
      ...personalRecipe,
      id: "recipe_older_popular",
      recipe: {
        ...personalRecipe.recipe,
        title: "Ziti Bake"
      },
      timesCooked: 3,
      updatedAt: "2026-05-01T12:00:00.000Z"
    };
    const newerRecipe: WebSavedRecipe = {
      ...personalRecipe,
      id: "recipe_newer",
      recipe: {
        ...personalRecipe.recipe,
        title: "Apple Salad"
      },
      timesCooked: 1,
      updatedAt: "2026-06-05T12:00:00.000Z"
    };
    storeMocks.getSavedRecipes.mockResolvedValue([newerRecipe, olderPopularRecipe]);

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    const getRowTitles = () =>
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);

    await screen.findByText("Apple Salad");
    expect(getRowTitles()).toEqual(["Apple Salad", "Ziti Bake"]);

    const selectSort = (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: /Sort recipes\. Current:/ }));
      const menu = screen.getByRole("menu", { name: "Sort recipes" });
      expect(menu).toHaveClass("library-sort-menu");
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: label }));
    };

    selectSort("A-Z");
    expect(getRowTitles()).toEqual(["Apple Salad", "Ziti Bake"]);

    selectSort("Most cooked");
    expect(getRowTitles()).toEqual(["Ziti Bake", "Apple Salad"]);
    expect(localStorage.getItem("linkdish:web:cookbook-sort:v1")).toBe("mostCooked");

    fireEvent.click(
      screen.getByRole("button", { name: "Order: Most cooked first. Reverse order" })
    );
    expect(getRowTitles()).toEqual(["Apple Salad", "Ziti Bake"]);
    expect(localStorage.getItem("linkdish:web:cookbook-sort-direction:v1")).toBe("reverse");

    selectSort("Recent");
    expect(getRowTitles()).toEqual(["Ziti Bake", "Apple Salad"]);
    expect(screen.queryByRole("menuitemradio", { name: "Oldest" })).not.toBeInTheDocument();
  });

  it("restores the last sort and direction without offering cook counts to Family", async () => {
    localStorage.setItem("linkdish:web:cookbook-sort:v1", "az");
    localStorage.setItem("linkdish:web:cookbook-sort-direction:v1", "reverse");

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    await screen.findByText("Personal Rice");
    expect(screen.getByRole("button", { name: "Sort recipes. Current: A-Z" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Order: Z to A. Reverse order" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Family" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort recipes. Current: A-Z" }));

    expect(screen.getByRole("menuitemradio", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "A-Z" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: "Most cooked" })).not.toBeInTheDocument();
  });

  it("maps a remembered Most cooked preference to Recent while Family is visible", async () => {
    localStorage.setItem("linkdish:web:cookbook-sort:v1", "mostCooked");

    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    );

    await screen.findByText("Personal Rice");
    fireEvent.click(screen.getByRole("tab", { name: "Family" }));

    expect(
      screen.getByRole("button", { name: "Sort recipes. Current: Recent" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Personal" }));
    expect(
      screen.getByRole("button", { name: "Sort recipes. Current: Most cooked" })
    ).toBeInTheDocument();
    expect(localStorage.getItem("linkdish:web:cookbook-sort:v1")).toBe("mostCooked");
  });
});
