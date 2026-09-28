import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import { resetCookSessionStoreForTests } from "../../data/cook-session-store";
import { resetLibraryStoreForTests } from "../../data/library-store";
import { resetPreferencesForTests, setPreference } from "../../preferences/preferences-store";
import { resetLinkDishWebDbForTests, SAVED_RECIPES_STORE_NAME } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import { flushCookSessionWrites } from "../cook-mode/cook-session-writer";

import { FeaturedRecipePage } from "./FeaturedRecipePage";

import type { WebSavedRecipe } from "../library/saved-recipe-types";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => analyticsMocks);

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: false, loading: false, user: null })
}));

const upgradeMocks = vi.hoisted(() => ({ requestUpgradeSheet: vi.fn() }));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const renderFeaturedRoute = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<FeaturedRecipePage />} path="/featured/:slug" />
        <Route element={<div>Import route</div>} path="/import" />
        <Route element={<div>Saved recipe route</div>} path="/recipes/:id" />
      </Routes>
    </MemoryRouter>
  );

describe("FeaturedRecipePage", () => {
  beforeEach(() => {
    fakeIdb.reset();
    localStorage.clear();
    localStorage.setItem("linkdish:web:starter-recipes-seeded:v1", "true");
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    resetCookSessionStoreForTests();
    resetPreferencesForTests();
    setDataChannelFactoryForTests(() => null);
    analyticsMocks.trackWebV2AnalyticsEvent.mockReset();
    upgradeMocks.requestUpgradeSheet.mockReset();
    document.title = "LinkDish";
    document.head.querySelector('meta[name="description"]')?.remove();
  });

  afterEach(async () => {
    await flushCookSessionWrites();
  });

  it("renders the featured recipe the LinkDish way, with a save CTA", () => {
    renderFeaturedRoute("/featured/classic-sandwich-bread");

    expect(
      screen.getByRole("heading", { level: 1, name: "Classic Sandwich Bread" })
    ).toBeInTheDocument();
    expect(screen.getByText(/Saved from/)).toHaveTextContent(
      "Saved from kingarthurbaking.com with LinkDish"
    );
    expect(screen.getByRole("button", { name: "Save to my cookbook" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import your own recipe" })).toHaveAttribute(
      "href",
      "/import"
    );
    expect(screen.getByRole("heading", { name: "Method" })).toBeInTheDocument();
    expect(screen.getByText("Nutrition")).toBeInTheDocument();
    expect(document.title).toBe("Classic Sandwich Bread · LinkDish");
    expect(
      document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content
    ).toContain("Classic Sandwich Bread, saved from kingarthurbaking.com with LinkDish");
    expect(screen.queryByText(/warming up the oven/i)).not.toBeInTheDocument();
  });

  it("shows fractions the domain way and converts units on request", () => {
    renderFeaturedRoute("/featured/classic-sandwich-bread");

    expect(screen.getByRole("checkbox", { name: /^½ cup \(113 g\) milk/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    expect(screen.getByRole("checkbox", { name: /^360 g King Arthur/ })).toBeInTheDocument();
    expect(screen.getByText(/preheat your oven to 175°C/)).toBeInTheDocument();
  });

  it("scales by servings", () => {
    renderFeaturedRoute("/featured/classic-sandwich-bread");

    const stepper = screen.getByRole("group", { name: "Servings" });
    expect(within(stepper).getByRole("spinbutton")).toHaveTextContent("Serves 16");
    for (let index = 0; index < 16; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    }

    expect(within(stepper).getByRole("spinbutton")).toHaveTextContent("Serves 32");
    expect(screen.getByRole("checkbox", { name: /^6 cups \(720 g\)/ })).toBeInTheDocument();
  });

  it("saves the recipe to the cookbook", async () => {
    renderFeaturedRoute("/featured/banana-bread");

    fireEvent.click(screen.getByRole("button", { name: "Save to my cookbook" }));

    expect(await screen.findByRole("button", { name: "In your cookbook" })).toBeInTheDocument();
    const records = fakeIdb.records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME);
    expect(records.map((record) => record.recipe.title)).toEqual(["Banana Bread"]);
    expect(analyticsMocks.trackWebV2AnalyticsEvent).toHaveBeenCalledWith({
      name: "recipe_saved",
      properties: { source_type: "url", surface: "import_result" },
      routeOrScreen: "/"
    });

    fireEvent.click(screen.getByRole("button", { name: "In your cookbook" }));
    await waitFor(() => expect(screen.getByText("Saved recipe route")).toBeInTheDocument());
  });

  it("uses the unit preference by default", () => {
    setPreference("units", "metric");
    renderFeaturedRoute("/featured/classic-sandwich-bread");

    expect(screen.getByRole("radio", { name: "Metric" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows a not-found state for unknown featured slugs", () => {
    renderFeaturedRoute("/featured/not-a-recipe");

    expect(screen.getByText("Featured recipe not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import a recipe" })).toHaveAttribute(
      "href",
      "/import"
    );
  });
});
