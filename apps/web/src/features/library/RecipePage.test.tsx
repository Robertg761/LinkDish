import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCookSessionStoreForTests } from "../../data/cook-session-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { resetPreferencesForTests } from "../../preferences/preferences-store";
import {
  COOK_SESSIONS_STORE_NAME,
  getLinkDishWebDb,
  RECIPE_SOURCE_IMAGES_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { flushCookSessionWrites } from "../cook-mode/cook-session-writer";
import { resetKitchenTimersForTests } from "../cook-mode/timer-store";

import { RecipePage } from "./RecipePage";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type * as ApiClientModuleNamespace from "../../api/client";
import type { CookSession } from "../../data/cook-session-store";
import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

type ApiClientModule = typeof ApiClientModuleNamespace;

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const apiMocks = vi.hoisted(() => ({
  createSharedRecipe: vi.fn(),
  deleteSharedRecipe: vi.fn(),
  getHousehold: vi.fn(),
  getSharedRecipes: vi.fn(),
  updateSharedRecipe: vi.fn()
}));

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<ApiClientModule>()),
  apiClient: apiMocks
}));

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent,
  trackWebV2AnalyticsEvent: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  user: null as { billingPlan?: string; email: string; id: string } | null
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: Boolean(authMocks.user),
    loading: false,
    user: authMocks.user
  })
}));

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn() }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const baseRecipe: Recipe = {
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
  ingredients: [{ text: "2 cups flour" }, { text: "2 cans beans" }, { text: "Salt to taste" }],
  nutrition: null,
  prepTimeMinutes: 15,
  servings: "4",
  sourceType: "recipe-webpage",
  sourceUrl: "https://www.example.com/chili",
  steps: [
    { index: 1, text: "Simmer everything for 10 minutes." },
    { index: 2, text: "Serve hot." }
  ],
  title: "Weeknight Chili"
};

const savedRecipe = (overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  createdAt: "2026-06-02T12:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id: "recipe_local",
  recipe: baseRecipe,
  sourceHost: "example.com",
  sourceUrl: baseRecipe.sourceUrl,
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-06-02T12:00:00.000Z",
  ...overrides
});

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
  recipe: { ...baseRecipe, sourceUrl: "https://family.example.com/chili", title: "Family Chili" },
  strategy: "recipe-schema",
  updatedAt: "2026-06-03T12:00:00.000Z",
  warnings: []
};

const seed = async (records: WebSavedRecipe[]) => {
  await getLinkDishWebDb();
  fakeIdb.seed(SAVED_RECIPES_STORE_NAME, records);
};

const renderAt = (path: string) =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<RecipePage />} path="/recipes/:id" />
          <Route element={<RecipePage />} path="/recipes/shared/:sharedId" />
          <Route element={<div>Cookbook route</div>} path="/" />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );

const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  return screen.getByRole("menu");
};

const stored = (id: string) => fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);

beforeEach(() => {
  fakeIdb.reset();
  localStorage.clear();
  localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
  resetLinkDishWebDbForTests();
  resetDataChangeFeedForTests();
  resetLibraryStoreForTests();
  resetCookSessionStoreForTests();
  resetKitchenTimersForTests();
  resetPreferencesForTests();
  setDataChannelFactoryForTests(() => null);
  authMocks.user = null;
  Object.values(apiMocks).forEach((mock) => mock.mockReset());
  analyticsMocks.trackWebEvent.mockReset();
  upgradeMocks.requestUpgradeSheet.mockReset();
  document.title = "LinkDish";
});

afterEach(async () => {
  await flushCookSessionWrites();
  vi.restoreAllMocks();
});

describe("RecipePage saved route", () => {
  it("shows the recipe, titles the tab, links the source and marks it opened", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");

    expect(await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" })).toBeVisible();
    expect(document.title).toBe("Weeknight Chili · LinkDish");
    expect(
      screen.getByRole("link", { name: "Open the original recipe on example.com" })
    ).toHaveAttribute("href", "https://www.example.com/chili");
    expect(screen.getByRole("button", { name: "Start cooking" })).toBeInTheDocument();
    expect(screen.queryByText(/Back to Cookbook/i)).not.toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "recipe_opened",
      properties: { surface: "recipe_detail" },
      routeOrScreen: "/recipes/:id"
    });
    await waitFor(() => expect(stored("recipe_local")?.lastOpenedAt).toBeDefined());
  });

  it("never links the synthetic source of a photo import and shows the photos", async () => {
    const url = "https://linkdish.app/image-imports/web-1-abc";
    await seed([
      savedRecipe({
        recipe: { ...baseRecipe, sourceUrl: url },
        sourceHost: "linkdish.app",
        sourceImageCount: 1,
        sourceUrl: url
      })
    ]);
    fakeIdb.seed(RECIPE_SOURCE_IMAGES_STORE_NAME, [
      {
        images: [{ dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }],
        recipeId: "recipe_local",
        updatedAt: "2026-06-02T12:00:00.000Z"
      }
    ]);
    renderAt("/recipes/recipe_local");

    expect(await screen.findByText("From your photos")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /linkdish\.app/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "View photo 1 of 1" })).toBeInTheDocument();
  });

  it("renders a recipe whose stored source URL cannot be parsed", async () => {
    await seed([
      savedRecipe({
        recipe: { ...baseRecipe, sourceUrl: "recipes/legacy-import", title: "Legacy Import" },
        sourceHost: "",
        sourceUrl: "recipes/legacy-import"
      })
    ]);
    renderAt("/recipes/recipe_local");

    expect(await screen.findByRole("heading", { level: 1, name: "Legacy Import" })).toBeVisible();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("shows a friendly not-found state", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/missing");

    expect(await screen.findByText("Recipe not found")).toBeInTheDocument();
    // The page's main heading, so route focus lands on it right away.
    expect(screen.getByRole("heading", { level: 1, name: "Recipe not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to your cookbook" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("offers a retry instead of 'not found' when storage fails to open", async () => {
    await seed([savedRecipe()]);
    resetLinkDishWebDbForTests();
    fakeIdb.failNextOpen(new DOMException("blocked", "UnknownError"));
    renderAt("/recipes/recipe_local");

    expect(await screen.findByText("This recipe didn’t load")).toBeInTheDocument();
    expect(screen.queryByText("Recipe not found")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" })).toBeVisible();
  });

  it("keeps ticked ingredients in the cook session so cook mode sees them", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");

    const flour = await screen.findByRole("checkbox", { name: "2 cups flour" });
    fireEvent.click(flour);
    expect(flour).toHaveAttribute("aria-checked", "true");

    await waitFor(async () => {
      await flushCookSessionWrites();
      expect(
        fakeIdb.record<CookSession>(COOK_SESSIONS_STORE_NAME, "recipe_local")?.checkedIngredients
      ).toEqual(["0:2 cups flour"]);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Start cooking" })[0]!);
    // Cook mode is its own chunk; the first test to open it waits for the import.
    fireEvent.click(
      await screen.findByRole("button", { name: "Show all ingredients" }, { timeout: 5_000 })
    );
    const sheet = screen.getByRole("dialog", { name: "Ingredients" });
    expect(within(sheet).getByRole("checkbox", { name: "2 cups flour" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("scales by servings and remembers the choice for this recipe", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");

    await screen.findByRole("checkbox", { name: "2 cans beans" });
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));

    expect(screen.getByRole("checkbox", { name: "4 cans beans" })).toBeInTheDocument();
    expect(screen.getByText("Some ingredients can’t be scaled automatically.")).toBeInTheDocument();
    await waitFor(() => expect(stored("recipe_local")?.preferredServings).toBe(8));
  });

  it("puts secondary actions in one overflow menu, without sync for starters", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    await seed([savedRecipe({ id: "starter-pitas", isStarter: true })]);
    renderAt("/recipes/starter-pitas");

    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });
    const menu = openMenu();
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);

    expect(labels).toEqual([
      "Add to meal plan…",
      "Add to collection…",
      "Edit tags…",
      "Share",
      "Share cardA picture to post or send",
      "Print",
      "Edit recipe",
      "Duplicate",
      "Delete recipe"
    ]);
    // Named groups, with Delete on its own after a separator.
    expect(within(menu).getAllByRole("group")).toHaveLength(3);
    expect(within(menu).getByRole("group", { name: "Plan & organise" })).toBeInTheDocument();
    expect(within(menu).getByRole("group", { name: "Share & print" })).toBeInTheDocument();
    expect(
      within(within(menu).getByRole("group", { name: "Edit" })).getAllByRole("menuitem")
    ).toHaveLength(2);
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);
  });

  it("duplicates into a new recipe and opens it", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Duplicate" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Weeknight Chili (copy)" })
    ).toBeVisible();
    expect(await screen.findByText("Copy made. Tweak away!")).toBeInTheDocument();
  });

  it("sends free users with a full cookbook to the upgrade sheet instead of duplicating", async () => {
    authMocks.user = { billingPlan: "free", email: "a@example.com", id: "user_1" };
    await seed(
      Array.from({ length: 15 }, (_, index) =>
        savedRecipe({ id: index === 0 ? "recipe_local" : `recipe_${index}` })
      )
    );
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() =>
      expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit")
    );
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toHaveLength(15);
  });

  it("shares the recipe as text with its source link", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Share" }));

    await waitFor(() => expect(share).toHaveBeenCalled());
    const [data] = share.mock.calls[0] as [ShareData];
    expect(data.title).toBe("Weeknight Chili");
    expect(data.url).toBe("https://www.example.com/chili");
    expect(data.text).toContain("INGREDIENTS");
    expect(data.text).toContain("• 2 cups flour");
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });

  it("copies the recipe when the share sheet is unavailable", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Share" }));

    expect(await screen.findByText("Recipe copied. Paste it anywhere.")).toBeInTheDocument();
    expect(writeText.mock.calls[0]?.[0]).toContain("Source: https://www.example.com/chili");
  });

  it("deletes a local recipe with an Undo toast", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Delete recipe" }));

    expect(await screen.findByText("Cookbook route")).toBeInTheDocument();
    expect(stored("recipe_local")).toBeUndefined();

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(stored("recipe_local")?.recipe.title).toBe("Weeknight Chili"));
  });

  it("deletes the household copy first for synced recipes", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    apiMocks.deleteSharedRecipe.mockResolvedValue(undefined);
    await seed([savedRecipe({ sync: { sharedRecipeId: "shared_9", status: "synced" } })]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Delete recipe" }));
    const confirm = screen.getByRole("dialog", { name: "Delete recipe?" });
    expect(apiMocks.deleteSharedRecipe).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Cookbook route")).toBeInTheDocument();
    expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_9");
    expect(stored("recipe_local")).toBeUndefined();
  });

  it("keeps a synced recipe when the household copy can't be deleted", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    apiMocks.deleteSharedRecipe.mockRejectedValue(new Error("offline"));
    await seed([savedRecipe({ sync: { sharedRecipeId: "shared_9", status: "synced" } })]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Delete recipe" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Delete recipe?" })).getByRole("button", {
        name: "Delete"
      })
    );

    await waitFor(() => expect(apiMocks.deleteSharedRecipe).toHaveBeenCalled());
    expect(screen.queryByText("Cookbook route")).not.toBeInTheDocument();
    expect(stored("recipe_local")).toBeDefined();
  });

  it("shares a recipe with the household and reports it once", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    apiMocks.getHousehold.mockResolvedValue({ household: { id: "household_1" } });
    apiMocks.createSharedRecipe.mockResolvedValue({
      recipe: { ...sharedRecipe, id: "shared_new" }
    });
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Share with household" }));

    expect(await screen.findByText("Synced to your household.")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "family_shared",
      properties: { recipe_count: 1, share_scope: "household" },
      routeOrScreen: "/recipes/:id"
    });
    await waitFor(() => expect(stored("recipe_local")?.sync?.status).toBe("synced"));
  });

  it("explains a failed sync instead of failing silently", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    apiMocks.getHousehold.mockRejectedValue(new Error("offline"));
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Share with household" }));

    expect(
      await screen.findByText("This recipe couldn’t sync. Check your connection and try again.")
    ).toBeInTheDocument();
  });

  it("edits in a sheet and marks synced recipes as having local edits", async () => {
    authMocks.user = { billingPlan: "family", email: "a@example.com", id: "user_1" };
    await seed([savedRecipe({ sync: { sharedRecipeId: "shared_9", status: "synced" } })]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Edit recipe" }));
    const editor = screen.getByRole("dialog", { name: "Edit recipe" });
    fireEvent.change(within(editor).getByLabelText("Title"), {
      target: { value: "Best Weeknight Chili" }
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Best Weeknight Chili" })
    ).toBeVisible();
    expect(stored("recipe_local")?.sync?.status).toBe("dirty");
    expect(screen.getByText("Saved here. Sync to update your household’s copy.")).toBeVisible();
  });

  it("opens the editor for ?edit=1 links", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local?edit=1");

    expect(await screen.findByRole("dialog", { name: "Edit recipe" })).toBeInTheDocument();
  });

  it("opens cook mode for ?cook=1 links (the command palette's Start cooking)", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local?cook=1");

    expect(
      await screen.findByRole(
        "dialog",
        { name: "Cooking mode for Weeknight Chili" },
        { timeout: 5_000 }
      )
    ).toBeInTheDocument();
  });

  it("logs a finished cook from cook mode", async () => {
    await seed([savedRecipe()]);
    renderAt("/recipes/recipe_local");
    await screen.findByRole("heading", { level: 1, name: "Weeknight Chili" });

    fireEvent.click(screen.getByRole("button", { name: "Start cooking" }));
    const cookMode = await screen.findByRole(
      "dialog",
      { name: "Cooking mode for Weeknight Chili" },
      { timeout: 5_000 }
    );
    fireEvent.click(within(cookMode).getByRole("button", { name: "Next step" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    fireEvent.click(within(cookMode).getByRole("button", { name: "Finish cooking" }));
    fireEvent.click(within(cookMode).getByRole("button", { name: "Log this cook" }));

    await waitFor(() => expect(stored("recipe_local")?.timesCooked).toBe(1));
    expect(stored("recipe_local")?.cookLog).toHaveLength(1);
    expect(await screen.findByText("Logged. Nice cooking!")).toBeInTheDocument();
  });
});

describe("RecipePage shared route", () => {
  beforeEach(() => {
    authMocks.user = { billingPlan: "family", email: "owner@example.com", id: "user_owner" };
    apiMocks.getSharedRecipes.mockResolvedValue({ recipes: [sharedRecipe] });
  });

  it("shows owner-only controls and saves a family recipe copy", async () => {
    await seed([]);
    renderAt("/recipes/shared/shared_1");

    expect(await screen.findByRole("heading", { level: 1, name: "Family Chili" })).toBeVisible();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith({
      eventName: "recipe_opened",
      properties: { surface: "shared_link" },
      routeOrScreen: "/recipes/shared/:id"
    });
    expect(screen.getByText("Shared by Robert")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the original recipe on family.example.com" })
    ).toHaveAttribute("href", "https://family.example.com/chili");

    const menu = openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Edit recipe" })).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Unshare from household" })
    ).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Save a copy" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Family Chili (copy)" })
    ).toBeVisible();
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toHaveLength(1);
  });

  it("asks before unsharing a recipe", async () => {
    apiMocks.deleteSharedRecipe.mockResolvedValue(undefined);
    renderAt("/recipes/shared/shared_1");
    await screen.findByRole("heading", { level: 1, name: "Family Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Unshare from household" }));
    const dialog = screen.getByRole("dialog", { name: "Unshare recipe?" });
    expect(dialog.closest(".confirmation-dialog-backdrop")?.parentElement).toBe(document.body);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep shared" }));
    expect(apiMocks.deleteSharedRecipe).not.toHaveBeenCalled();

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Unshare from household" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Unshare recipe?" })).getByRole("button", {
        name: "Unshare"
      })
    );

    expect(await screen.findByText("Cookbook route")).toBeInTheDocument();
    expect(apiMocks.deleteSharedRecipe).toHaveBeenCalledWith("shared_1");
  });

  it("saves owner edits to the household copy", async () => {
    apiMocks.updateSharedRecipe.mockImplementation((_id: string, payload: { recipe: Recipe }) =>
      Promise.resolve({ recipe: { ...sharedRecipe, recipe: payload.recipe } })
    );
    renderAt("/recipes/shared/shared_1");
    await screen.findByRole("heading", { level: 1, name: "Family Chili" });

    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "Edit recipe" }));
    const editor = screen.getByRole("dialog", { name: "Edit family recipe" });
    fireEvent.change(within(editor).getByLabelText("Title"), {
      target: { value: "Family Chili Deluxe" }
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Family Chili Deluxe" })
    ).toBeVisible();
    expect(apiMocks.updateSharedRecipe).toHaveBeenCalledWith(
      "shared_1",
      expect.objectContaining({ notes: "Family favorite" })
    );
  });

  it("hides edit and unshare for other household members", async () => {
    authMocks.user = { billingPlan: "family", email: "member@example.com", id: "user_member" };
    renderAt("/recipes/shared/shared_1");
    await screen.findByRole("heading", { level: 1, name: "Family Chili" });

    const menu = openMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Edit recipe" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Unshare/ })).toBeNull();
    // "Save a copy" alone isn't an "Edit" group.
    expect(within(menu).queryByRole("group", { name: "Edit" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Save a copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save a copy to my cookbook" })).toBeInTheDocument();
  });

  it("asks signed-out visitors to sign in", async () => {
    authMocks.user = null;
    renderAt("/recipes/shared/shared_1");

    expect(await screen.findByText("Sign in to see this recipe")).toBeInTheDocument();
    expect(apiMocks.getSharedRecipes).not.toHaveBeenCalled();
  });
});
