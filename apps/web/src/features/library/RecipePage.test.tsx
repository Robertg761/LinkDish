import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecipePage } from "./RecipePage";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { SharedRecipe } from "@linkdish/api-contracts";

const apiClientMocks = vi.hoisted(() => ({
  deleteSharedRecipe: vi.fn(),
  getSharedRecipes: vi.fn(),
  updateSharedRecipe: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    deleteSharedRecipe: apiClientMocks.deleteSharedRecipe,
    getSharedRecipes: apiClientMocks.getSharedRecipes,
    updateSharedRecipe: apiClientMocks.updateSharedRecipe
  }
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
    loading: false,
    user: authMocks.user
  })
}));

const storeMocks = vi.hoisted(() => ({
  deleteSavedRecipe: vi.fn(),
  duplicateSavedRecipe: vi.fn(),
  getSavedRecipeById: vi.fn(),
  getSharedRecipeOwnerLabel: vi.fn(
    (recipe: SharedRecipe) => recipe.ownerDisplayName ?? recipe.ownerEmail
  ),
  incrementSavedRecipeTimesCooked: vi.fn(),
  saveSharedRecipeCopy: vi.fn(),
  sharedRecipeToWebSavedRecipe: vi.fn((recipe: SharedRecipe): WebSavedRecipe => {
    const sourceHost = new URL(recipe.recipe.sourceUrl).hostname;

    return {
      createdAt: recipe.createdAt,
      extraction: {
        fetchMode: recipe.fetchMode,
        provenance: recipe.provenance,
        strategy: recipe.strategy,
        warnings: recipe.warnings
      },
      id: recipe.sourceSavedRecipeId ?? `shared-${recipe.id}`,
      notes: recipe.notes,
      recipe: recipe.recipe,
      sourceHost,
      sourceUrl: recipe.recipe.sourceUrl,
      sync: {
        lastSyncedAt: recipe.updatedAt,
        sharedRecipeId: recipe.id,
        status: "synced"
      },
      updatedAt: recipe.updatedAt
    };
  }),
  syncRecipeToHousehold: vi.fn(),
  updateSavedRecipe: vi.fn()
}));

vi.mock("./saved-recipe-store", () => ({
  deleteSavedRecipe: storeMocks.deleteSavedRecipe,
  duplicateSavedRecipe: storeMocks.duplicateSavedRecipe,
  getSavedRecipeById: storeMocks.getSavedRecipeById,
  getSharedRecipeOwnerLabel: storeMocks.getSharedRecipeOwnerLabel,
  incrementSavedRecipeTimesCooked: storeMocks.incrementSavedRecipeTimesCooked,
  saveSharedRecipeCopy: storeMocks.saveSharedRecipeCopy,
  sharedRecipeToWebSavedRecipe: storeMocks.sharedRecipeToWebSavedRecipe,
  syncRecipeToHousehold: storeMocks.syncRecipeToHousehold,
  updateSavedRecipe: storeMocks.updateSavedRecipe
}));

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
    cookTimeMinutes: 35,
    ingredients: [{ text: "2 cans beans" }, { text: "Salt to taste" }],
    nutrition: null,
    prepTimeMinutes: 15,
    servings: "6",
    sourceType: "recipe-webpage",
    sourceUrl: "https://family.example.com/chili",
    steps: [{ index: 1, text: "Simmer everything" }],
    title: "Family Chili"
  },
  strategy: "recipe-schema",
  updatedAt: "2026-06-03T12:00:00.000Z",
  warnings: []
};

const renderSharedRecipePage = () => {
  render(
    <MemoryRouter initialEntries={["/recipes/shared/shared_1"]}>
      <Routes>
        <Route path="/recipes/shared/:sharedId" element={<RecipePage />} />
        <Route path="/recipes/:id" element={<div>Personal recipe route</div>} />
        <Route path="/" element={<div>Cookbook route</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe("RecipePage shared route", () => {
  beforeEach(() => {
    authMocks.user = {
      billingPlan: "family",
      email: "owner@example.com",
      id: "user_owner"
    };
    apiClientMocks.deleteSharedRecipe.mockReset();
    apiClientMocks.getSharedRecipes.mockReset();
    apiClientMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });
    apiClientMocks.updateSharedRecipe.mockReset();
    analyticsMocks.trackWebEvent.mockReset();
    storeMocks.deleteSavedRecipe.mockReset();
    storeMocks.duplicateSavedRecipe.mockReset();
    storeMocks.getSavedRecipeById.mockReset();
    storeMocks.saveSharedRecipeCopy.mockReset();
    storeMocks.saveSharedRecipeCopy.mockResolvedValue({
      createdAt: "2026-06-04T12:00:00.000Z",
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      },
      id: "recipe_copy",
      recipe: {
        ...sharedRecipe.recipe,
        title: "Family Chili Copy"
      },
      sourceHost: "family.example.com",
      sourceUrl: sharedRecipe.recipe.sourceUrl,
      sync: {
        status: "local_only"
      },
      updatedAt: "2026-06-04T12:00:00.000Z"
    } satisfies WebSavedRecipe);
    storeMocks.sharedRecipeToWebSavedRecipe.mockClear();
    storeMocks.syncRecipeToHousehold.mockReset();
    storeMocks.updateSavedRecipe.mockReset();
  });

  it("shows owner-only controls and saves a family recipe copy", async () => {
    renderSharedRecipePage();

    expect(await screen.findByRole("heading", { name: "Family Chili" })).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "recipe_opened",
      routeOrScreen: "/recipes/shared/:id",
      properties: {
        surface: "shared_link"
      }
    });
    expect(screen.queryByText("Recipe Preview")).not.toBeInTheDocument();
    expect(
      screen.getByText("Webpage · 6 servings · Prep 15 min · Cook 35 min")
    ).toBeInTheDocument();
    expect(screen.getByText("family.example.com")).toHaveAttribute(
      "href",
      "https://family.example.com/chili"
    );
    expect(screen.getByRole("heading", { name: "Ingredients" }).closest(".card")).toBeNull();
    expect(screen.getByRole("heading", { name: "Method" }).closest(".card")).toBeNull();
    expect(screen.getAllByText("Method").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unshare/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save copy/i }));

    await waitFor(() => {
      expect(storeMocks.saveSharedRecipeCopy).toHaveBeenCalledWith(sharedRecipe);
    });
    await waitFor(() => {
      expect(screen.getByText("Personal recipe route")).toBeInTheDocument();
    });
  });

  it("portals recipe dialogs outside the animated page container", async () => {
    renderSharedRecipePage();

    expect(await screen.findByRole("heading", { name: "Family Chili" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editorHeading = screen.getByRole("heading", { name: "Edit Recipe" });
    expect(editorHeading.closest(".recipe-editor-backdrop")?.parentElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to shopping list" }));

    const shoppingDialog = screen.getByRole("dialog", { name: "Add ingredients" });
    expect(shoppingDialog.closest(".shopping-sheet-backdrop")?.parentElement).toBe(document.body);
  });

  it("uses an app-native confirmation before unsharing a recipe", async () => {
    apiClientMocks.deleteSharedRecipe.mockResolvedValue(undefined);
    renderSharedRecipePage();

    expect(await screen.findByRole("heading", { name: "Family Chili" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unshare/i }));

    const firstDialog = screen.getByRole("dialog", { name: "Unshare recipe?" });
    expect(firstDialog.closest(".confirmation-dialog-backdrop")?.parentElement).toBe(document.body);
    expect(apiClientMocks.deleteSharedRecipe).not.toHaveBeenCalled();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Keep shared" }));
    expect(screen.queryByRole("dialog", { name: "Unshare recipe?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /unshare/i }));
    const confirmation = screen.getByRole("dialog", { name: "Unshare recipe?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Unshare" }));

    await waitFor(() => {
      expect(apiClientMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_1");
      expect(screen.getByText("Cookbook route")).toBeInTheDocument();
    });
  });

  it("hides shared edit and unshare controls for non-owners", async () => {
    authMocks.user = {
      billingPlan: "family",
      email: "member@example.com",
      id: "user_member"
    };

    renderSharedRecipePage();

    expect(await screen.findByRole("heading", { name: "Family Chili" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unshare/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save copy/i })).toBeInTheDocument();
  });

  it("scales detail ingredients from the recipe header stepper", async () => {
    renderSharedRecipePage();

    expect(await screen.findByRole("heading", { name: "Family Chili" })).toBeInTheDocument();
    expect(screen.getByText("2 cans beans")).toBeInTheDocument();
    expect(
      screen.queryByText("Some ingredients can’t be scaled automatically.")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2×" }));

    expect(screen.getByText("4 cans beans")).toBeInTheDocument();
    expect(screen.getByText("Salt to taste")).toBeInTheDocument();
    expect(screen.getByText("Some ingredients can’t be scaled automatically.")).toBeInTheDocument();
  });
});
