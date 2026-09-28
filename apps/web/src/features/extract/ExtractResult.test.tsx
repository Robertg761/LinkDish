import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCookSessionStoreForTests } from "../../data/cook-session-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { resetPreferencesForTests } from "../../preferences/preferences-store";
import { getLinkDishWebDb, resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { flushCookSessionWrites } from "../cook-mode/cook-session-writer";
import { saveRecipe, syncRecipeToHousehold } from "../library/saved-recipe-store";
import { resetShoppingSyncForTests } from "../shopping/shopping-sync";

import { ExtractResult } from "./ExtractResult";

import type { ExtractResultProps } from "./ExtractResult";
import type * as SavedRecipeStore from "../library/saved-recipe-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

vi.mock("../library/saved-recipe-store", async (importOriginal) => ({
  ...(await importOriginal<typeof SavedRecipeStore>()),
  forceSaveRecipe: vi.fn(),
  saveRecipe: vi.fn(),
  syncRecipeToHousehold: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiBaseUrl: "/api",
  apiClient: { getHousehold: vi.fn(() => Promise.resolve({ household: null })) },
  isExtractorApiError: () => false
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  user: { billingPlan: "plus", email: "cook@example.com", id: "user_1" } as {
    billingPlan?: "free" | "plus" | "family";
    email: string;
    id: string;
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false, user: authMocks.user })
}));

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn() }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const recipe: Recipe = {
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
};

const savedRecipe = (overrides: Partial<WebSavedRecipe> = {}): WebSavedRecipe => ({
  createdAt: "2026-09-28T12:00:00.000Z",
  extraction: {
    fetchMode: "http",
    provenance: ["jsonld"],
    strategy: "recipe-schema",
    warnings: []
  },
  id: "rice-id",
  recipe,
  sourceHost: "example.com",
  sourceUrl: "https://example.com/rice",
  sync: { status: "local_only" },
  timesCooked: 0,
  updatedAt: "2026-09-28T12:00:00.000Z",
  ...overrides
});

const renderResult = (props: Partial<ExtractResultProps> = {}) => {
  const onReset = vi.fn();
  const onDiscard = vi.fn();
  const onSaved = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={["/import"]}>
      <Routes>
        <Route
          element={
            <ExtractResult
              extraction={{
                fetchMode: "http",
                provenance: ["jsonld"],
                strategy: "recipe-schema",
                warnings: []
              }}
              onDiscard={onDiscard}
              onReset={onReset}
              onSaved={onSaved}
              recipe={recipe}
              sourceUrl="https://example.com/rice"
              {...props}
            />
          }
          path="/import"
        />
        <Route element={<p>Saved recipe page</p>} path="/recipes/:id" />
      </Routes>
    </MemoryRouter>
  );

  return { ...view, onDiscard, onReset, onSaved };
};

const saveButton = () => screen.getAllByRole("button", { name: "Save to cookbook" })[0]!;

describe("ExtractResult", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    localStorage.clear();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetCookSessionStoreForTests();
    resetPreferencesForTests();
    resetShoppingSyncForTests();
    setDataChannelFactoryForTests(() => null);
    await getLinkDishWebDb();
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    vi.mocked(saveRecipe).mockReset();
    vi.mocked(syncRecipeToHousehold).mockReset();
    vi.mocked(syncRecipeToHousehold).mockImplementation((saved) =>
      Promise.resolve({ ...saved, sync: { status: "local_only" } })
    );
    upgradeMocks.requestUpgradeSheet.mockReset();
  });

  afterEach(async () => {
    await flushCookSessionWrites();
    vi.restoreAllMocks();
  });

  it("shows the recipe the LinkDish way, linked to its source", () => {
    renderResult();

    expect(screen.getByRole("heading", { level: 1, name: "Personal Rice" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the original recipe on example.com" })
    ).toHaveAttribute("href", "https://example.com/rice");
    expect(screen.getByRole("heading", { name: "Ingredients" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Method" })).toBeInTheDocument();
    expect(screen.getByText("Just imported")).toBeInTheDocument();
  });

  it("never links an unsafe source URL", () => {
    renderResult({ sourceUrl: "javascript:alert(1)" });

    expect(
      screen.queryByRole("link", { name: /Open the original recipe/u })
    ).not.toBeInTheDocument();
  });

  it("labels pasted text instead of linking to a made-up page", () => {
    renderResult({ sourceUrl: "https://linkdish.app/text-imports/abc123" });

    expect(screen.getByText("From your text")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /linkdish\.app/u })).not.toBeInTheDocument();
  });

  it("shows Saved as soon as the local write lands, with the household sync in the background", async () => {
    let finishSync: ((recipe: WebSavedRecipe) => void) | undefined;
    vi.mocked(syncRecipeToHousehold).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSync = resolve;
        })
    );
    vi.mocked(saveRecipe).mockResolvedValue({ recipe: savedRecipe(), success: true });
    const { onSaved } = renderResult();

    fireEvent.click(saveButton());

    expect(await screen.findByText("Saved to your cookbook")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "rice-id" }));
    expect(saveRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ recipe, sourceUrl: "https://example.com/rice" }),
      true
    );
    // No household is known for this account: nothing claims to be syncing to one.
    expect(screen.queryByText(/household/iu)).not.toBeInTheDocument();

    await act(async () => {
      finishSync?.(savedRecipe({ sync: { sharedRecipeId: "s1", status: "synced" } }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Shared with your household")).toBeInTheDocument();
  });

  it("offers the next steps once saved", async () => {
    vi.mocked(saveRecipe).mockResolvedValue({ recipe: savedRecipe(), success: true });
    renderResult();

    fireEvent.click(saveButton());

    const banner = (await screen.findByText("Saved to your cookbook")).closest("section")!;
    expect(screen.getAllByRole("button", { name: "Start cooking" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add to shopping list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
    expect(screen.getByText("In your cookbook")).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Open recipe" }));
    expect(await screen.findByText("Saved recipe page")).toBeInTheDocument();
  });

  it("opens the save-limit upgrade sheet when the free cookbook is full", async () => {
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };
    vi.mocked(saveRecipe).mockResolvedValue({ error: "limit_exceeded", success: false });
    renderResult();

    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("Your free cookbook is full");
    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
    expect(saveRecipe).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("offers to open or replace a copy that's already saved", async () => {
    vi.mocked(saveRecipe).mockResolvedValue({ error: "duplicate_prompt", success: false });
    renderResult();

    fireEvent.click(saveButton());

    expect(await screen.findByText("You saved this one before")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace it" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open my copy" })).toBeInTheDocument();
  });

  it("reports a successful save even when localStorage refuses writes", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.mocked(saveRecipe).mockResolvedValue({ recipe: savedRecipe(), success: true });
    renderResult();

    fireEvent.click(saveButton());

    expect(await screen.findByText("Saved to your cookbook")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses plain language when a save fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(saveRecipe).mockRejectedValue(new Error("IndexedDB transaction aborted"));
    renderResult();

    fireEvent.click(saveButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").not.toMatch(/indexeddb/iu);
    expect(alert).toHaveTextContent("We couldn't save that. Please try again.");
  });

  it("asks before throwing away an unsaved import", async () => {
    const { onDiscard, onReset } = renderResult();

    fireEvent.click(screen.getByRole("button", { name: "Import another" }));
    const dialog = await screen.findByRole("dialog", { name: "Keep this recipe?" });
    expect(onReset).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("can save on the way out", async () => {
    vi.mocked(saveRecipe).mockResolvedValue({ recipe: savedRecipe(), success: true });
    const { onReset } = renderResult();

    fireEvent.click(screen.getByRole("button", { name: "Import another" }));
    const dialog = await screen.findByRole("dialog", { name: "Keep this recipe?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save it" }));

    await waitFor(() => expect(onReset).toHaveBeenCalledOnce());
    expect(saveRecipe).toHaveBeenCalledOnce();
  });

  it("shows gentle notes instead of extractor jargon", () => {
    renderResult({
      confidenceScore: 0.55,
      extraction: {
        fetchMode: "http",
        provenance: ["readability"],
        strategy: "article-pattern",
        warnings: ["Article extraction relies on pattern matching and may need fallback review."]
      },
      missingFields: ["servings"]
    });

    const notes = screen.getByRole("heading", { name: "Worth a double-check" }).closest("section")!;
    expect(notes).toHaveTextContent("give the amounts a quick look");
    expect(notes).toHaveTextContent("The page didn't mention how many it serves.");
    expect(notes.textContent ?? "").not.toMatch(/extraction|fallback|pattern/iu);
  });
});
