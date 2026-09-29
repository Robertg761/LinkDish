import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCoreIconName } from "../../components/icons/lucide-icons";
import { MENU_SHEET_MEDIA_QUERY } from "../../components/Menu";
import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCollectionsStoreForTests } from "../../data/collections-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME,
  SHOPPING_ITEMS_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { resetShoppingListStoreForTests } from "../shopping/shopping-list-store";
import { resetShoppingSyncForTests, SHOPPING_HOUSEHOLD_CACHE_KEY } from "../shopping/shopping-sync";

import { resetLibrarySessionStateForTests } from "./components/library-model";
import { resetSearchEngineForTests } from "./components/use-library-search";
import { resetSharedRecipesCacheForTests } from "./components/use-shared-recipes";
import { LibraryPage } from "./LibraryPage";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { WebCollection } from "../../data/collections-store";
import type { WebShoppingItem } from "../shopping/shopping-list-store";
import type { SharedRecipe } from "@linkdish/api-contracts";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const apiMocks = vi.hoisted(() => {
  class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = "ExtractorApiError";
    }
  }

  return {
    ExtractorApiError,
    createSharedRecipe: vi.fn(),
    deleteSharedRecipe: vi.fn(),
    getHousehold: vi.fn(),
    getSharedRecipes: vi.fn(),
    updateSharedRecipe: vi.fn(),
    upsertShoppingItems: vi.fn()
  };
});

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: {
    createSharedRecipe: apiMocks.createSharedRecipe,
    deleteSharedRecipe: apiMocks.deleteSharedRecipe,
    getHousehold: apiMocks.getHousehold,
    getSharedRecipes: apiMocks.getSharedRecipes,
    updateSharedRecipe: apiMocks.updateSharedRecipe,
    upsertShoppingItems: apiMocks.upsertShoppingItems
  },
  ExtractorApiError: apiMocks.ExtractorApiError,
  isExtractorApiError: (error: unknown) => error instanceof apiMocks.ExtractorApiError
}));

const authMocks = vi.hoisted(() => ({
  user: null as { billingPlan?: string; email: string; id: string } | null
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    credentialsKey: `session:${authMocks.user?.id ?? ""}`,
    credentialsReady: true,
    isAuthenticated: Boolean(authMocks.user),
    user: authMocks.user
  })
}));

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn(() => true) }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({
  trackWebError: vi.fn(),
  trackWebEvent: analyticsMocks.trackWebEvent,
  trackWebV2AnalyticsEvent: vi.fn()
}));

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

interface RecipeOptions {
  title: string;
  daysAgo?: number;
  ingredients?: string[];
  servings?: string | null;
  prep?: number | null;
  cook?: number | null;
  image?: boolean;
  extra?: Partial<WebSavedRecipe>;
}

const makeRecipe = (id: string, options: RecipeOptions): WebSavedRecipe => {
  const sourceUrl = `https://example.com/${id}`;

  return {
    createdAt: iso(options.daysAgo ?? 1),
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    },
    id,
    recipe: {
      confidence: {
        fieldProvenance: {
          cookTimeMinutes: null,
          ingredients: "jsonld",
          nutrition: null,
          prepTimeMinutes: null,
          servings: null,
          steps: "jsonld",
          title: "jsonld"
        },
        missingFields: [],
        notes: [],
        score: 0.9,
        summary: "ok"
      },
      cookTimeMinutes: options.cook ?? null,
      image: options.image ? { source: "jsonld", url: `https://images.test/${id}.jpg` } : null,
      ingredients: (options.ingredients ?? ["1 onion"]).map((text) => ({ text })),
      nutrition: null,
      prepTimeMinutes: options.prep ?? null,
      servings: options.servings === undefined ? "4 servings" : options.servings,
      sourceType: "recipe-webpage",
      sourceUrl,
      steps: [{ index: 1, text: "Cook it." }],
      title: options.title
    },
    sourceHost: "example.com",
    sourceUrl,
    sync: { status: "local_only" },
    timesCooked: 0,
    updatedAt: iso(options.daysAgo ?? 1),
    ...options.extra
  } as WebSavedRecipe;
};

const seedRecipes = (recipes: WebSavedRecipe[]) => fakeIdb.seed(SAVED_RECIPES_STORE_NAME, recipes);

const seedCollections = (collections: WebCollection[]) =>
  fakeIdb.seed(COLLECTIONS_STORE_NAME, collections);

const storedRecipe = (id: string) => fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);

const LocationProbe: React.FC = () => {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
};

const libraryTree = () => (
  <ToastProvider>
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<LibraryPage />} path="/" />
        <Route element={<LocationProbe />} path="*" />
      </Routes>
    </MemoryRouter>
  </ToastProvider>
);

const renderPage = () => render(libraryTree());

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const cardFor = (title: string): HTMLElement => {
  const link = screen.getByRole("link", { name: title });
  const card = link.closest("article");
  expect(card).not.toBeNull();
  return card as HTMLElement;
};

const gridTitles = () =>
  Array.from(document.querySelectorAll(".library-results .recipe-card-title")).map(
    (element) => element.textContent
  );

const openCardMenu = (title: string) => {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${title}` }));
  return screen.getByRole("menu", { name: `Actions for ${title}` });
};

const sharedRecipe = (overrides: Partial<SharedRecipe> = {}): SharedRecipe => ({
  createdAt: iso(3),
  fetchMode: "http",
  householdId: "household_1",
  id: "shared_1",
  ownerDisplayName: "Robert",
  ownerEmail: "robert@example.com",
  ownerUserId: "user_owner",
  provenance: ["jsonld"],
  recipe: makeRecipe("family-chili", { title: "Family Chili", prep: 10, cook: 40 }).recipe,
  strategy: "recipe-schema",
  updatedAt: iso(3),
  warnings: [],
  ...overrides
});

describe("LibraryPage", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
    sessionStorage.clear();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetCollectionsStoreForTests();
    resetLibrarySessionStateForTests();
    resetSharedRecipesCacheForTests();
    resetSearchEngineForTests();
    setDataChannelFactoryForTests(() => ({
      close: vi.fn(),
      onmessage: null,
      postMessage: vi.fn()
    }));
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    // Starters are already seeded; each test seeds exactly the cookbook it needs.
    localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    await getLinkDishWebDb();

    authMocks.user = null;
    upgradeMocks.requestUpgradeSheet.mockReset();
    upgradeMocks.requestUpgradeSheet.mockReturnValue(true);
    analyticsMocks.trackWebEvent.mockReset();
    apiMocks.createSharedRecipe.mockReset();
    apiMocks.deleteSharedRecipe.mockReset();
    apiMocks.deleteSharedRecipe.mockResolvedValue({ deleted: true });
    apiMocks.getHousehold.mockReset();
    apiMocks.getHousehold.mockResolvedValue({ household: null });
    apiMocks.getSharedRecipes.mockReset();
    apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [] });
    apiMocks.updateSharedRecipe.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows photo cards with clean meta, a recipe count and the controls in one column", async () => {
    seedRecipes([
      makeRecipe("bread", {
        cook: 40,
        image: true,
        prep: 12,
        servings: "16, 1 loaf",
        title: "Classic Sandwich Bread"
      })
    ]);

    renderPage();

    await screen.findByText("Classic Sandwich Bread");
    const card = cardFor("Classic Sandwich Bread");
    expect(screen.getByRole("heading", { level: 1, name: "Cookbook" })).toBeInTheDocument();
    expect(screen.getByText("1 recipe")).toBeInTheDocument();
    expect(card.textContent).toContain("52 min");
    expect(card.textContent).toContain("Serves 16");
    expect(card.textContent).not.toContain("16, 1 loaf");
    expect(within(card).getByRole("link", { name: "Classic Sandwich Bread" })).toHaveAttribute(
      "href",
      "/recipes/bread"
    );
    expect(card.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("/api/image?")
    );
    expect(
      within(card).getByRole("button", { name: "Favorite Classic Sandwich Bread" }).closest("a")
    ).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search your cookbook" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Cookbook" })).toBeInTheDocument();
  });

  it("ranks title matches above ingredient matches and highlights the matched words", async () => {
    seedRecipes([
      makeRecipe("rice-bowl", {
        daysAgo: 1,
        ingredients: ["2 chicken thighs", "1 cup rice"],
        title: "Sesame Rice Bowl"
      }),
      makeRecipe("lemon-chicken", { daysAgo: 5, title: "Lemon Chicken" }),
      makeRecipe("soup", { daysAgo: 2, ingredients: ["1 can tomatoes"], title: "Tomato Soup" })
    ]);

    renderPage();
    await screen.findByText("Tomato Soup");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search your cookbook" }), {
      target: { value: "chicken" }
    });

    await waitFor(() => expect(gridTitles()).toEqual(["Lemon Chicken", "Sesame Rice Bowl"]));
    expect(screen.getByText(/for “chicken”/)).toHaveTextContent("2 recipes for “chicken”");
    await waitFor(() =>
      expect(cardFor("Lemon Chicken").querySelector("mark")).toHaveTextContent("Chicken")
    );
    expect(screen.queryByRole("region", { name: /Cook again/ })).not.toBeInTheDocument();
  });

  it("offers to drop filters when a search only matches outside them", async () => {
    seedRecipes([
      makeRecipe("curry", { title: "Red Curry" }),
      makeRecipe("salad", { extra: { favorite: true }, title: "Green Salad" })
    ]);

    renderPage();
    await screen.findByText("Red Curry");

    fireEvent.click(screen.getByRole("button", { name: /Favorites/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search your cookbook" }), {
      target: { value: "curry" }
    });

    expect(
      await screen.findByRole("heading", { name: "No recipes match “curry”" })
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show 1 match without filters" }));

    await waitFor(() => expect(gridTitles()).toEqual(["Red Curry"]));
    expect(screen.getByRole("button", { name: /Favorites/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("combines filter chips with AND and clears them in one tap", async () => {
    seedRecipes([
      makeRecipe("fav-quick", {
        cook: 10,
        daysAgo: 3,
        extra: { favorite: true },
        prep: 5,
        title: "Fast Favorite"
      }),
      makeRecipe("fav-slow", {
        cook: 120,
        daysAgo: 2,
        extra: { favorite: true },
        title: "Slow Favorite"
      }),
      makeRecipe("quick", { cook: 15, daysAgo: 1, title: "Quick Noodles" }),
      makeRecipe("cooked", {
        daysAgo: 4,
        extra: { lastCookedAt: iso(2), timesCooked: 2 },
        title: "Cooked Before"
      })
    ]);

    renderPage();
    await screen.findByText("Quick Noodles");

    const favorites = screen.getByRole("button", { name: /Favorites/ });
    expect(favorites).toHaveTextContent("2");
    fireEvent.click(favorites);
    await waitFor(() => expect(gridTitles()).toEqual(["Slow Favorite", "Fast Favorite"]));

    fireEvent.click(screen.getByRole("button", { name: /Quick/ }));
    await waitFor(() => expect(gridTitles()).toEqual(["Fast Favorite"]));
    expect(screen.getByText(/of/, { selector: ".library-results-count" })).toHaveTextContent(
      "1 of 4 recipes"
    );

    // Active chips lead the row (after Collections and Clear), so they never scroll out of view.
    const row = within(screen.getByRole("group", { name: "Filter recipes" }));
    expect(row.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "New collection",
      "Clear (2)",
      expect.stringContaining("Favorites"),
      expect.stringContaining("Quick"),
      expect.stringContaining("Not cooked yet")
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Clear 2 filters" }));
    await waitFor(() => expect(gridTitles()).toHaveLength(4));

    fireEvent.click(screen.getByRole("button", { name: /Not cooked yet/ }));
    await waitFor(() => expect(gridTitles()).not.toContain("Cooked Before"));
  });

  it("toggles a favorite optimistically and saves it", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    const heart = await screen.findByRole("button", { name: "Favorite Tomato Soup" });
    expect(heart).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(heart);

    expect(screen.getByRole("button", { name: "Favorite Tomato Soup" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await waitFor(() => expect(storedRecipe("soup")?.favorite).toBe(true));
  });

  it("deletes a local recipe instantly and restores it with Undo", async () => {
    seedRecipes([
      makeRecipe("soup", { title: "Tomato Soup" }),
      makeRecipe("salad", { title: "Salad" })
    ]);

    renderPage();
    await screen.findByText("Tomato Soup");

    fireEvent.click(within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Tomato Soup")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(storedRecipe("soup")).toBeUndefined());
    expect(await screen.findByText("Deleted “Tomato Soup”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("link", { name: "Tomato Soup" })).toBeInTheDocument();
    await waitFor(() => expect(storedRecipe("soup")?.recipe.title).toBe("Tomato Soup"));
  });

  it("still deletes a recipe whose scans can't be read back, without offering Undo", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);
    fakeIdb.seed(RECIPE_SOURCE_IMAGES_STORE_NAME, [
      { images: [], recipeId: "soup", updatedAt: iso(1) }
    ]);

    renderPage();
    await screen.findByText("Tomato Soup");
    // Chrome: the file behind a large stored value is gone ("Failed to read large IndexedDB value").
    fakeIdb.failNextGet(
      RECIPE_SOURCE_IMAGES_STORE_NAME,
      new DOMException("Failed to read large IndexedDB value", "NotReadableError")
    );
    fireEvent.click(within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Deleted “Tomato Soup”")).toBeInTheDocument();
    expect(storedRecipe("soup")).toBeUndefined();
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "soup")).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("This recipe could not be deleted. Please try again.")
    ).not.toBeInTheDocument();
  });

  it("keeps the copy saved again elsewhere when Undo comes after it", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(storedRecipe("soup")).toBeUndefined());

    // Another tab saves the recipe again (and renames it) before Undo: that copy stays.
    seedRecipes([makeRecipe("soup", { title: "Roasted Tomato Soup" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      await screen.findByText("“Roasted Tomato Soup” is already back in your cookbook.")
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Roasted Tomato Soup" })).toBeInTheDocument();
    expect(storedRecipe("soup")?.recipe.title).toBe("Roasted Tomato Soup");
  });

  it("keeps a recipe deleted when Undo would take a free cookbook past its limit", async () => {
    seedRecipes(
      Array.from({ length: 15 }, (_, index) =>
        makeRecipe(`recipe-${index}`, { daysAgo: index + 1, title: `Recipe ${index}` })
      )
    );

    renderPage();
    await screen.findByText("Recipe 0");
    fireEvent.click(within(openCardMenu("Recipe 0")).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(storedRecipe("recipe-0")).toBeUndefined());

    // Another recipe was saved (say, in another tab) before Undo: the cookbook is full again.
    seedRecipes([makeRecipe("recipe-new", { title: "Fresh Save" })]);
    upgradeMocks.requestUpgradeSheet.mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(
      await screen.findByText(
        "Your cookbook is full, so “Recipe 0” stays deleted. Free cookbooks hold 15 recipes."
      )
    ).toBeInTheDocument();
    expect(storedRecipe("recipe-0")).toBeUndefined();
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toHaveLength(15);

    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
    // With the upgrade sheet already seen this session, the plans page opens instead.
    expect(await screen.findByTestId("location")).toHaveTextContent("/pricing?upgrade=plus");
  });

  it("confirms before deleting a household-synced recipe and removes the household copy first", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    seedRecipes([
      makeRecipe("chili", {
        extra: { sync: { sharedRecipeId: "shared_9", status: "synced" } },
        title: "Chili"
      })
    ]);

    renderPage();
    await screen.findByText("Chili");

    fireEvent.click(within(openCardMenu("Chili")).getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete shared recipe?" });
    expect(storedRecipe("chili")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete everywhere" }));

    await waitFor(() => expect(storedRecipe("chili")).toBeUndefined());
    expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_9");
  });

  it("closes a Delete everywhere confirmation when the account that opened it signs out", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    seedRecipes([
      makeRecipe("chili", {
        extra: { sync: { sharedRecipeId: "shared_9", status: "synced" } },
        title: "Chili"
      })
    ]);

    const view = renderPage();
    await screen.findByText("Chili");
    fireEvent.click(within(openCardMenu("Chili")).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete shared recipe?" })).toBeVisible();

    // Signed out (say, from another tab): the household delete was for the account that left.
    authMocks.user = null;
    view.rerender(libraryTree());

    expect(screen.queryByRole("dialog", { name: "Delete shared recipe?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete everywhere" })).not.toBeInTheDocument();

    // Nor does it come back when that account signs in again.
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    view.rerender(libraryTree());
    expect(screen.queryByRole("dialog", { name: "Delete shared recipe?" })).not.toBeInTheDocument();
    expect(apiMocks.deleteSharedRecipe).not.toHaveBeenCalled();
    expect(storedRecipe("chili")).toBeDefined();
  });

  it("removes a synced recipe here once its household copy is gone, even if its scans can't be read", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    seedRecipes([
      makeRecipe("chili", {
        extra: { sync: { sharedRecipeId: "shared_9", status: "synced" } },
        title: "Chili"
      })
    ]);
    fakeIdb.seed(RECIPE_SOURCE_IMAGES_STORE_NAME, [
      { images: [], recipeId: "chili", updatedAt: iso(1) }
    ]);

    renderPage();
    await screen.findByText("Chili");
    fakeIdb.failNextGet(
      RECIPE_SOURCE_IMAGES_STORE_NAME,
      new DOMException("Failed to read large IndexedDB value", "NotReadableError")
    );
    fireEvent.click(within(openCardMenu("Chili")).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete shared recipe?" })).getByRole(
        "button",
        { name: "Delete everywhere" }
      )
    );

    expect(
      await screen.findByText("Deleted “Chili” here and from your Family cookbook")
    ).toBeInTheDocument();
    expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_9");
    expect(storedRecipe("chili")).toBeUndefined();
    expect(fakeIdb.record(RECIPE_SOURCE_IMAGES_STORE_NAME, "chili")).toBeUndefined();
  });

  it("keeps a synced recipe when the household copy could not be deleted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    apiMocks.deleteSharedRecipe.mockRejectedValue(new apiMocks.ExtractorApiError("nope", 500));
    seedRecipes([
      makeRecipe("chili", {
        extra: { sync: { sharedRecipeId: "shared_9", status: "synced" } },
        title: "Chili"
      })
    ]);

    renderPage();
    await screen.findByText("Chili");
    fireEvent.click(within(openCardMenu("Chili")).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Delete shared recipe?" })).getByRole(
        "button",
        { name: "Delete everywhere" }
      )
    );

    expect(
      await screen.findByText(
        "This recipe could not be deleted from your household. Please try again."
      )
    ).toBeInTheDocument();
    expect(storedRecipe("chili")).toBeDefined();
  });

  it("adds a household member's ingredients to the household list before the check answers", async () => {
    resetShoppingListStoreForTests();
    resetShoppingSyncForTests();
    authMocks.user = { billingPlan: "family", email: "cook@example.com", id: "user_1" };
    // This account is known (cached) to share a household list; the fresh check is still out.
    localStorage.setItem(
      SHOPPING_HOUSEHOLD_CACHE_KEY,
      JSON.stringify({ checkedAt: Date.now(), household: true, userId: "user_1" })
    );
    apiMocks.getHousehold.mockReturnValue(new Promise(() => undefined));
    apiMocks.upsertShoppingItems.mockReturnValue(new Promise(() => undefined));
    seedRecipes([makeRecipe("soup", { ingredients: ["2 carrots"], title: "Tomato Soup" })]);

    renderPage();
    await screen.findByRole("link", { name: "Tomato Soup" });
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Add to shopping list" })
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Add \d+ items?$/u }));

    await waitFor(() =>
      expect(fakeIdb.records<WebShoppingItem>(SHOPPING_ITEMS_STORE_NAME)).toHaveLength(1)
    );
    // Marked for the household list, not kept on this device for good.
    expect(fakeIdb.records<WebShoppingItem>(SHOPPING_ITEMS_STORE_NAME)[0]?.sync.status).not.toBe(
      "local_only"
    );
    resetShoppingSyncForTests();
  });

  describe("the shopping sheet when another account signs straight in", () => {
    const addButton = /^Add \d+ items?$/u;
    const openShoppingFor = (title: string) =>
      fireEvent.click(
        within(openCardMenu(title)).getByRole("menuitem", { name: "Add to shopping list" })
      );

    beforeEach(() => {
      resetShoppingListStoreForTests();
      resetShoppingSyncForTests();
      apiMocks.upsertShoppingItems.mockReturnValue(new Promise(() => undefined));
      seedRecipes([makeRecipe("soup", { ingredients: ["2 carrots"], title: "Tomato Soup" })]);
    });

    afterEach(() => {
      resetShoppingSyncForTests();
    });

    it("closes the sheet the last account opened", async () => {
      authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_a" };
      apiMocks.getHousehold.mockResolvedValue({ household: { id: "household_a" } });

      const view = renderPage();
      await screen.findByRole("link", { name: "Tomato Soup" });
      openShoppingFor("Tomato Soup");
      expect(await screen.findByRole("button", { name: addButton })).toBeInTheDocument();

      authMocks.user = { billingPlan: "free", email: "b@example.com", id: "user_b" };
      view.rerender(libraryTree());

      expect(screen.queryByRole("button", { name: addButton })).not.toBeInTheDocument();
      expect(fakeIdb.records<WebShoppingItem>(SHOPPING_ITEMS_STORE_NAME)).toHaveLength(0);
    });

    it("never lets the last account's household answer decide where the next one's items go", async () => {
      const checks = {
        user_a: deferred<{ household: { id: string } | null }>(),
        user_b: deferred<{ household: { id: string } | null }>()
      };
      apiMocks.getHousehold.mockImplementation(
        () => checks[(authMocks.user?.id ?? "user_b") as keyof typeof checks].promise
      );
      authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_a" };

      const view = renderPage();
      await screen.findByRole("link", { name: "Tomato Soup" });
      openShoppingFor("Tomato Soup");
      await waitFor(() => expect(apiMocks.getHousehold).toHaveBeenCalled());

      // B has no household; A's check for the same recipe is still out.
      authMocks.user = { billingPlan: "free", email: "b@example.com", id: "user_b" };
      view.rerender(libraryTree());
      expect(screen.queryByRole("button", { name: addButton })).not.toBeInTheDocument();

      openShoppingFor("Tomato Soup");
      const add = await screen.findByRole("button", { name: addButton });

      await act(async () => {
        checks.user_b.resolve({ household: null });
        await checks.user_b.promise;
      });
      await act(async () => {
        checks.user_a.resolve({ household: { id: "household_a" } });
        await checks.user_a.promise;
      });

      fireEvent.click(add);

      await waitFor(() =>
        expect(fakeIdb.records<WebShoppingItem>(SHOPPING_ITEMS_STORE_NAME)).toHaveLength(1)
      );
      expect(fakeIdb.records<WebShoppingItem>(SHOPPING_ITEMS_STORE_NAME)[0]?.sync.status).toBe(
        "local_only"
      );
      expect(await screen.findByText("1 item added to your shopping list")).toBeInTheDocument();
    });
  });

  it("duplicates a recipe and opens the copy", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Duplicate" })
    );

    const location = await screen.findByTestId("location");
    const copy = fakeIdb
      .records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME)
      .find((recipe) => recipe.recipe.title === "Tomato Soup (copy)");
    expect(copy).toBeDefined();
    expect(location).toHaveTextContent(`/recipes/${copy?.id ?? ""}`);
  });

  it("asks free cooks to upgrade instead of duplicating past the limit", async () => {
    seedRecipes(
      Array.from({ length: 15 }, (_, index) =>
        makeRecipe(`recipe-${index}`, { daysAgo: index + 1, title: `Recipe ${index}` })
      )
    );

    renderPage();
    await screen.findByText("Recipe 0");
    fireEvent.click(within(openCardMenu("Recipe 0")).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() =>
      expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit")
    );
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toHaveLength(15);
  });

  it("shows a quota meter that turns into an upgrade prompt near the free limit", async () => {
    seedRecipes([
      ...Array.from({ length: 12 }, (_, index) =>
        makeRecipe(`recipe-${index}`, { title: `Recipe ${index}` })
      ),
      makeRecipe("starter-soup", { extra: { isStarter: true }, title: "Starter Soup" })
    ]);

    renderPage();

    const meter = await screen.findByRole("region", { name: "Free cookbook" });
    expect(within(meter).getByText("Almost full")).toBeInTheDocument();
    expect(meter).toHaveTextContent("12 of 15 saved · 3 left. The starter recipe doesn't count.");
    // The header adds up with the meter: saved recipes and starters are counted apart.
    expect(screen.getByText("12 recipes + 1 starter")).toBeInTheDocument();

    fireEvent.click(within(meter).getByRole("button", { name: "Get Plus" }));
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
  });

  it("never clamps the count: a cookbook over the free limit says so", async () => {
    seedRecipes(
      Array.from({ length: 17 }, (_, index) =>
        makeRecipe(`recipe-${index}`, { title: `Recipe ${index}` })
      )
    );

    renderPage();

    const meter = await screen.findByRole("region", { name: "Free cookbook" });
    expect(within(meter).getByText("Over the free limit")).toBeInTheDocument();
    expect(meter).toHaveTextContent(
      "17 of 15 saved · 2 over the free limit. Everything stays; new saves need Plus."
    );
    expect(within(meter).getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "17 of 15 saved"
    );
    expect(screen.getByText("17 recipes")).toBeInTheDocument();
  });

  it("hides the quota meter for Plus cooks", async () => {
    authMocks.user = { billingPlan: "plus", email: "plus@example.com", id: "user_plus" };
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");

    expect(screen.queryByRole("region", { name: "Free cookbook" })).not.toBeInTheDocument();
  });

  it("welcomes an empty cookbook with a paste-a-link field that opens the importer", async () => {
    const readText = vi.fn().mockResolvedValue("Look at this https://example.com/soup!");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Paste a link. Get cooking." })
    ).toBeInTheDocument();
    expect(screen.getByText("No recipes yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search your cookbook" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "How it works" }).children).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/import?url=https%3A%2F%2Fexample.com%2Fsoup"
    );
    expect(readText).toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("validates a typed link before importing and lists sample recipes", async () => {
    renderPage();

    const input = await screen.findByRole("textbox", { name: "Recipe link" });
    fireEvent.change(input, { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("doesn't look like a link");

    // The samples load after the welcome (placeholder cards hold their place meanwhile).
    const samples = await screen.findByRole("region", { name: "Try a sample" });
    expect(
      await within(samples).findByRole("link", { name: "Classic Sandwich Bread" })
    ).toHaveAttribute("href", "/featured/classic-sandwich-bread");

    fireEvent.change(input, { target: { value: "www.seriouseats.com/best-chili" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/import?url=https%3A%2F%2Fwww.seriouseats.com%2Fbest-chili"
    );
  });

  it("greets a cook who only has starter recipes and lists them below", async () => {
    seedRecipes([
      makeRecipe("starter-bars", { extra: { isStarter: true }, title: "Berry Oat Bars" })
    ]);

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Paste a link. Get cooking." })
    ).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /Starter recipes/ })).toBeInTheDocument();
    expect(cardFor("Berry Oat Bars").textContent).toContain("Starter");
    // A new cook's first paint doesn't wait for the rest of the icon set.
    expect(
      Array.from(document.querySelectorAll("[data-icon]"), (icon) =>
        icon.getAttribute("data-icon")
      ).filter((name) => !isCoreIconName(name ?? ""))
    ).toEqual([]);
  });

  it("opens a first visit on the welcome while it sets up the starter recipes", async () => {
    localStorage.removeItem("linkdish:web:starter-recipes-seeded:v1");
    resetLinkDishWebDbForTests();
    const releaseStorage = fakeIdb.holdNextOpen();

    const { container } = renderPage();

    // Storage hasn't answered yet: the welcome shows anyway, with the recipes' skeleton below.
    expect(
      await screen.findByRole("heading", { name: "Paste a link. Get cooking." })
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to LinkDish")).toBeInTheDocument();
    expect(container.querySelector(".library-welcome ~ .library-skeleton")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: /Starter recipes/ })).not.toBeInTheDocument();

    releaseStorage();

    // The same welcome stays; the starter recipes it just seeded take the skeleton's place.
    expect(await screen.findByRole("heading", { name: /Starter recipes/ })).toBeInTheDocument();
    expect(screen.getByText("Welcome to LinkDish")).toBeInTheDocument();
    expect(container.querySelector(".library-skeleton")).toBeNull();
    expect(document.querySelectorAll(".library-grid .recipe-card")).toHaveLength(3);
    expect(localStorage.getItem("linkdish:web:starter-recipes-seeded:v1")).toBe("true");
  });

  it("keeps a returning cook's loading cookbook to a skeleton, without the welcome", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);
    resetLinkDishWebDbForTests();
    const releaseStorage = fakeIdb.holdNextOpen();

    const { container } = renderPage();

    await waitFor(() => expect(container.querySelector(".library-skeleton")).not.toBeNull());
    // Long enough for a first visit's welcome to have shown (the frame after the first paint).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      screen.queryByRole("heading", { name: "Paste a link. Get cooking." })
    ).not.toBeInTheDocument();

    releaseStorage();

    expect(await screen.findByText("Tomato Soup")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Paste a link. Get cooking." })
    ).not.toBeInTheDocument();
  });

  it("shows an error with a retry instead of an empty cookbook when storage fails", async () => {
    resetLinkDishWebDbForTests();
    fakeIdb.failNextOpen(new Error("disk on fire"));

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "We couldn't open your cookbook" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Paste a link. Get cooking." })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("asks to reload when another tab upgrades storage", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    act(() => {
      fakeIdb.fireBlocking();
    });

    expect(
      await screen.findByText("LinkDish was updated in another tab. Reload to keep going.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("sorts from a menu, remembers the choice and supports the old stored keys", async () => {
    localStorage.setItem("linkdish:web:cookbook-sort:v1", "mostCooked");
    seedRecipes([
      makeRecipe("apple", { daysAgo: 1, extra: { timesCooked: 1 }, title: "Apple Salad" }),
      makeRecipe("ziti", { daysAgo: 9, extra: { timesCooked: 5 }, title: "Ziti Bake" }),
      makeRecipe("miso", { cook: 5, daysAgo: 4, prep: 5, title: "Miso Soup" })
    ]);

    renderPage();
    await screen.findByText("Ziti Bake");
    expect(gridTitles()).toEqual(["Ziti Bake", "Apple Salad", "Miso Soup"]);

    const chooseSort = (label: string) => {
      fireEvent.click(screen.getByRole("button", { name: /^Sort recipes\. Current:/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: label }));
    };

    expect(
      screen.getByRole("button", { name: "Sort recipes. Current: Most cooked" })
    ).toBeInTheDocument();
    chooseSort("A–Z");
    expect(gridTitles()).toEqual(["Apple Salad", "Miso Soup", "Ziti Bake"]);
    expect(localStorage.getItem("linkdish:web:cookbook-sort:v1")).toBe("az");

    chooseSort("Quickest");
    expect(gridTitles()[0]).toBe("Miso Soup");

    chooseSort("Recently added");
    expect(gridTitles()).toEqual(["Apple Salad", "Miso Soup", "Ziti Bake"]);

    fireEvent.click(screen.getByRole("button", { name: /^Sort recipes\. Current:/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Reverse order" }));
    expect(gridTitles()).toEqual(["Ziti Bake", "Miso Soup", "Apple Salad"]);
    expect(localStorage.getItem("linkdish:web:cookbook-sort-direction:v1")).toBe("reverse");
  });

  it("opens the sort and card menus as action sheets on touch phones", async () => {
    const mediaQuery = (matches: (query: string) => boolean) => (query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: matches(query),
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn()
    });
    vi.mocked(window.matchMedia).mockImplementation(
      mediaQuery((query) => query === MENU_SHEET_MEDIA_QUERY)
    );

    try {
      seedRecipes([
        makeRecipe("apple", { daysAgo: 9, title: "Apple Salad" }),
        makeRecipe("ziti", { daysAgo: 1, title: "Ziti Bake" })
      ]);

      renderPage();
      await screen.findByText("Ziti Bake");
      expect(gridTitles()).toEqual(["Ziti Bake", "Apple Salad"]);

      fireEvent.click(screen.getByRole("button", { name: /^Sort recipes\. Current:/ }), {
        detail: 1
      });
      const sortMenu = screen.getByRole("menu", { name: "Sort recipes" });
      expect(sortMenu).toHaveClass("menu-in-sheet");
      expect(within(sortMenu).getByRole("group", { name: "Sort by" })).toContainElement(
        screen.getByRole("menuitemradio", { name: "A–Z" })
      );
      fireEvent.click(screen.getByRole("menuitemradio", { name: "A–Z" }));
      expect(gridTitles()).toEqual(["Apple Salad", "Ziti Bake"]);

      fireEvent.click(screen.getByRole("button", { name: "More actions for Ziti Bake" }), {
        detail: 1
      });
      const cardMenu = screen.getByRole("menu", { name: "Actions for Ziti Bake" });
      expect(cardMenu).toHaveClass("menu-in-sheet");
      expect(cardMenu.closest(".menu-sheet")).toHaveTextContent("Ziti Bake");
      expect(
        within(within(cardMenu).getByRole("group", { name: "Plan & organise" }))
          .getAllByRole("menuitem")
          .map((item) => item.textContent)
      ).toEqual(["Add to collection…", "Edit tags…", "Add to meal plan…", "Add to shopping list"]);
    } finally {
      vi.mocked(window.matchMedia).mockImplementation(mediaQuery(() => false));
    }
  });

  it("switches between grid and list and remembers the layout", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    expect(cardFor("Tomato Soup")).toHaveClass("recipe-card-grid");

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    expect(cardFor("Tomato Soup")).toHaveClass("recipe-card-list");
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(localStorage.getItem("linkdish:web:cookbook-view:v1")).toBe("list");
  });

  it("shows Cook again and Quick weeknights shelves for a bigger cookbook", async () => {
    seedRecipes([
      makeRecipe("a", {
        cook: 10,
        extra: { lastCookedAt: iso(1), timesCooked: 3 },
        title: "Alpha"
      }),
      makeRecipe("b", {
        cook: 20,
        extra: { lastCookedAt: iso(3), timesCooked: 1 },
        title: "Bravo"
      }),
      makeRecipe("c", { cook: 90, title: "Charlie" }),
      makeRecipe("d", { cook: 15, title: "Delta" }),
      makeRecipe("e", { cook: 60, title: "Echo" }),
      makeRecipe("f", { cook: 120, title: "Foxtrot" })
    ]);

    renderPage();

    const cookAgain = await screen.findByRole("region", { name: "Cook again" });
    expect(
      within(cookAgain)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Alpha", "Bravo"]);
    const quick = screen.getByRole("region", { name: "Quick weeknights" });
    expect(within(quick).getAllByRole("link")).toHaveLength(3);

    fireEvent.click(within(quick).getByRole("button", { name: "Show all quick recipes" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Cook again" })).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /Quick/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the Cookbook and its menus with core icons only, so it never waits for the rest", async () => {
    seedRecipes([
      makeRecipe("a", {
        cook: 10,
        extra: { favorite: true, lastCookedAt: iso(1), timesCooked: 3 },
        title: "Alpha"
      }),
      makeRecipe("b", {
        cook: 20,
        extra: { lastCookedAt: iso(3), timesCooked: 1 },
        title: "Bravo"
      }),
      makeRecipe("c", { cook: 90, extra: { tags: ["dinner"] }, image: true, title: "Charlie" }),
      makeRecipe("d", { cook: 15, title: "Delta Cake" }),
      makeRecipe("e", { cook: 60, title: "Echo Salad" }),
      makeRecipe("starter-soup", { extra: { isStarter: true }, title: "Starter Soup" })
    ]);
    const nonCoreIcons = () =>
      Array.from(document.querySelectorAll("[data-icon]"), (icon) =>
        icon.getAttribute("data-icon")
      ).filter((name) => !isCoreIconName(name ?? ""));

    renderPage();
    await screen.findByRole("region", { name: "Cook again" });
    expect(document.querySelectorAll("[data-icon]").length).toBeGreaterThan(10);
    expect(nonCoreIcons()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /^Sort recipes\. Current:/ }));
    expect(nonCoreIcons()).toEqual([]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    openCardMenu("Charlie");
    expect(nonCoreIcons()).toEqual([]);
  });

  it("jumps to search with the slash key when not typing", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");

    fireEvent.keyDown(window, { key: "/" });

    expect(screen.getByRole("searchbox", { name: "Search your cookbook" })).toHaveFocus();
  });

  it("adds a recipe to a new collection and filters by it", async () => {
    seedRecipes([
      makeRecipe("soup", { title: "Tomato Soup" }),
      makeRecipe("salad", { title: "Salad" })
    ]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Add to collection…" })
    );

    const sheet = await screen.findByRole("dialog", { name: "Add to collection" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Collection name" }), {
      target: { value: "Weeknight dinners" }
    });
    fireEvent.click(within(sheet).getByRole("radio", { name: "🍲" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Create and add" }));

    await waitFor(() => expect(fakeIdb.records(COLLECTIONS_STORE_NAME)).toHaveLength(1));
    const [collection] = fakeIdb.records<WebCollection>(COLLECTIONS_STORE_NAME);
    expect(collection).toMatchObject({ emoji: "🍲", name: "Weeknight dinners" });
    await waitFor(() => expect(storedRecipe("soup")?.collectionIds).toEqual([collection?.id]));
    const option = await within(sheet).findByRole("checkbox", { name: /Weeknight dinners/ });
    expect(option).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    fireEvent.click(await screen.findByRole("button", { name: /Weeknight dinners/ }));

    await waitFor(() => expect(gridTitles()).toEqual(["Tomato Soup"]));
  });

  it("edits tags with suggestions and turns shared tags into filter chips", async () => {
    seedRecipes([
      makeRecipe("soup", { title: "Tomato Soup" }),
      makeRecipe("salad", { extra: { tags: ["Weeknight"] }, title: "Salad" })
    ]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Edit tags…" })
    );

    const sheet = await screen.findByRole("dialog", { name: "Tags" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Add tag Weeknight" }));
    await waitFor(() => expect(storedRecipe("soup")?.tags).toEqual(["Weeknight"]));

    const input = within(sheet).getByRole("textbox", { name: "Add a tag" });
    fireEvent.change(input, { target: { value: "  comfort   food " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(storedRecipe("soup")?.tags).toEqual(["Weeknight", "comfort food"]));

    fireEvent.click(within(sheet).getByRole("button", { name: "Remove tag comfort food" }));
    await waitFor(() => expect(storedRecipe("soup")?.tags).toEqual(["Weeknight"]));

    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: /Weeknight/ })).toHaveTextContent("2");
  });

  it("renames, reorders and deletes collections", async () => {
    const now = iso(10);
    seedCollections([
      {
        createdAt: now,
        emoji: "🍰",
        id: "col-baking",
        name: "Baking",
        sortOrder: 0,
        updatedAt: now
      },
      { createdAt: now, id: "col-quick", name: "Quick", sortOrder: 1, updatedAt: now }
    ]);
    seedRecipes([
      makeRecipe("cake", { extra: { collectionIds: ["col-baking"] }, title: "Cake" }),
      makeRecipe("soup", { title: "Soup" })
    ]);

    renderPage();
    await screen.findByText("Cake");
    fireEvent.click(screen.getByRole("button", { name: "Collections" }));

    const sheet = await screen.findByRole("dialog", { name: "Collections" });
    const name = within(sheet).getByRole("textbox", { name: "Name of Baking" });
    fireEvent.change(name, { target: { value: "Baking day" } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(fakeIdb.record<WebCollection>(COLLECTIONS_STORE_NAME, "col-baking")?.name).toBe(
        "Baking day"
      )
    );

    fireEvent.click(within(sheet).getByRole("button", { name: "Move Quick up" }));
    await waitFor(() =>
      expect(fakeIdb.record<WebCollection>(COLLECTIONS_STORE_NAME, "col-quick")?.sortOrder).toBe(0)
    );

    fireEvent.click(within(sheet).getByRole("button", { name: "Delete Baking day" }));
    const confirm = within(sheet).getByRole("group", { name: "Delete Baking day" });
    expect(confirm).toHaveTextContent("1 recipe stay in your cookbook");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fakeIdb.record(COLLECTIONS_STORE_NAME, "col-baking")).toBeUndefined()
    );
    await waitFor(() => expect(storedRecipe("cake")?.collectionIds).toBeUndefined());
    expect(storedRecipe("cake")).toBeDefined();
  });

  it("opens a sign-in sheet when a signed-out cook taps the locked Family tab", async () => {
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(screen.getByRole("radio", { name: "Family" }));

    const sheet = await screen.findByRole("dialog", { name: "Cook together, in one place." });
    expect(within(sheet).getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/account"
    );
    expect(screen.getByRole("radio", { name: "Personal" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Cook together, in one place." })
      ).not.toBeInTheDocument()
    );
    expect(apiMocks.getSharedRecipes).not.toHaveBeenCalled();
  });

  it("opens a designed Family tab (not a system notice) when the account has no household", async () => {
    authMocks.user = { billingPlan: "plus", email: "plus@example.com", id: "user_plus" };
    apiMocks.getSharedRecipes.mockRejectedValue(
      new apiMocks.ExtractorApiError("Forbidden", 403, {
        message: "An active LinkDish Family household is required."
      })
    );
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    await waitFor(() => expect(apiMocks.getSharedRecipes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: "Family" }));

    const panel = await screen.findByRole("region", { name: "Family cookbook" });
    expect(
      within(panel).getByRole("heading", { name: "Cook together with Family" })
    ).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "See the Family plan" })).toHaveAttribute(
      "href",
      "/pricing?upgrade=family"
    );
    expect(within(panel).getByRole("link", { name: "I have an invite" })).toHaveAttribute(
      "href",
      "/household"
    );
    expect(screen.getByRole("radio", { name: "Family" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Not set up yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search your cookbook" })
    ).not.toBeInTheDocument();
  });

  it("shows Family recipes with who added them and saves personal copies", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    apiMocks.getSharedRecipes.mockResolvedValue({
      recipes: [
        sharedRecipe(),
        sharedRecipe({
          id: "shared_2",
          ownerDisplayName: "Ana",
          ownerEmail: "ana@example.com",
          ownerUserId: "user_ana",
          recipe: makeRecipe("pie", { title: "Apple Pie" }).recipe
        })
      ]
    });
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(screen.getByRole("radio", { name: "Family" }));

    const chili = await screen.findByRole("link", { name: "Family Chili" });
    expect(chili).toHaveAttribute("href", "/recipes/shared/shared_1");
    expect(cardFor("Family Chili").textContent).toContain("You");
    expect(cardFor("Apple Pie").textContent).toContain("Ana");
    expect(screen.getByText("2 family recipes")).toBeInTheDocument();

    // Only the owner can remove a recipe from Family.
    expect(
      within(openCardMenu("Apple Pie")).queryByRole("menuitem", { name: "Remove from Family" })
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(
      within(openCardMenu("Family Chili")).getByRole("menuitem", {
        name: "Save a copy to Personal"
      })
    );

    expect(await screen.findByText("Saved “Family Chili (copy)” to Personal")).toBeInTheDocument();
    expect(
      fakeIdb.records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME).map((recipe) => recipe.recipe.title)
    ).toContain("Family Chili (copy)");

    fireEvent.click(
      within(openCardMenu("Family Chili")).getByRole("menuitem", { name: "Remove from Family" })
    );
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Remove from Family?" })).getByRole(
        "button",
        {
          name: "Remove"
        }
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Family Chili" })).not.toBeInTheDocument()
    );
    expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_1");
  });

  it("closes the last account's Remove from Family and drops what it answers", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    let finishRemoval: (value: unknown) => void = () => undefined;
    apiMocks.deleteSharedRecipe.mockReturnValue(
      new Promise((resolve) => {
        finishRemoval = resolve;
      })
    );
    apiMocks.getSharedRecipes.mockResolvedValueOnce({ recipes: [sharedRecipe()] });
    apiMocks.getSharedRecipes.mockResolvedValueOnce({
      recipes: [
        sharedRecipe({
          householdId: "household_2",
          id: "shared_9",
          ownerUserId: "user_next",
          recipe: makeRecipe("stew", { title: "Next Stew" }).recipe
        })
      ]
    });
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    const view = renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(screen.getByRole("radio", { name: "Family" }));
    await screen.findByRole("link", { name: "Family Chili" });

    fireEvent.click(
      within(openCardMenu("Family Chili")).getByRole("menuitem", { name: "Remove from Family" })
    );
    const dialog = await screen.findByRole("dialog", { name: "Remove from Family?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_1"));

    // Another account signs straight in, with a household of its own.
    authMocks.user = { billingPlan: "family", email: "next@example.com", id: "user_next" };
    view.rerender(libraryTree());

    expect(screen.queryByRole("dialog", { name: "Remove from Family?" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Remove “Family Chili”/u)).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Next Stew" })).toBeInTheDocument();

    await act(async () => {
      finishRemoval({ deleted: true });
      await Promise.resolve();
    });

    expect(screen.queryByText("Removed from your Family cookbook")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next Stew" })).toBeInTheDocument();
  });

  it("shares a personal recipe to Family and tracks the first share", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    apiMocks.createSharedRecipe.mockResolvedValue({
      recipe: sharedRecipe({ id: "shared_new", updatedAt: iso(0) })
    });
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    renderPage();
    await screen.findByText("Tomato Soup");
    await waitFor(() => expect(apiMocks.getSharedRecipes).toHaveBeenCalled());
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Share to Family" })
    );

    expect(await screen.findByText("Shared with your Family cookbook")).toBeInTheDocument();
    await waitFor(() => expect(storedRecipe("soup")?.sync?.sharedRecipeId).toBe("shared_new"));
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "family_shared",
      properties: { recipe_count: 1, share_scope: "household" },
      routeOrScreen: "/"
    });
    expect(await within(cardFor("Tomato Soup")).findByText("Family")).toBeInTheDocument();
  });

  it("doesn't report a Family share to the account that signed in while it was out", async () => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    const share = deferred<{ recipe: SharedRecipe }>();
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    apiMocks.createSharedRecipe.mockReturnValue(share.promise);
    seedRecipes([makeRecipe("soup", { title: "Tomato Soup" })]);

    const view = renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(
      within(openCardMenu("Tomato Soup")).getByRole("menuitem", { name: "Share to Family" })
    );
    await waitFor(() => expect(apiMocks.createSharedRecipe).toHaveBeenCalled());

    authMocks.user = { billingPlan: "free", email: "next@example.com", id: "user_next" };
    view.rerender(libraryTree());

    await act(async () => {
      share.resolve({ recipe: sharedRecipe({ id: "shared_new", updatedAt: iso(0) }) });
      await share.promise;
    });

    // The device's copy still records the share; the toast was the last account's.
    await waitFor(() => expect(storedRecipe("soup")?.sync?.sharedRecipeId).toBe("shared_new"));
    expect(screen.queryByText("Shared with your Family cookbook")).not.toBeInTheDocument();
  });

  it("remembers search and filters for the trip to a recipe and back", async () => {
    seedRecipes([
      makeRecipe("soup", { extra: { favorite: true }, title: "Tomato Soup" }),
      makeRecipe("salad", { title: "Salad" })
    ]);

    const first = renderPage();
    await screen.findByText("Tomato Soup");
    fireEvent.click(screen.getByRole("button", { name: /Favorites/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search your cookbook" }), {
      target: { value: "tomato" }
    });
    first.unmount();

    renderPage();

    expect(await screen.findByRole("searchbox", { name: "Search your cookbook" })).toHaveValue(
      "tomato"
    );
    expect(screen.getByRole("button", { name: /Favorites/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
