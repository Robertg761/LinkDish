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

  it("renders a LinkDish kitchen recipe the LinkDish way, with a save CTA", () => {
    renderFeaturedRoute("/featured/brown-butter-berry-oat-bars");

    expect(
      screen.getByRole("heading", { level: 1, name: "Brown Butter Berry Oat Bars" })
    ).toBeInTheDocument();
    expect(screen.getByText(/An original recipe from the/)).toHaveTextContent(
      "An original recipe from the LinkDish kitchen"
    );
    expect(screen.getByText(/A LinkDish kitchen recipe\./)).toBeInTheDocument();
    // No third-party credit or link on LinkDish's own recipes.
    expect(screen.queryByText(/Saved from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recipe and photo ©/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Read the original" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to my cookbook" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import your own recipe" })).toHaveAttribute(
      "href",
      "/import"
    );
    expect(screen.getByRole("heading", { name: "Method" })).toBeInTheDocument();
    expect(document.title).toBe("Brown Butter Berry Oat Bars · LinkDish");
    expect(
      document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content
    ).toContain("Brown Butter Berry Oat Bars, an original LinkDish kitchen recipe");
    expect(screen.queryByText(/warming up the oven/i)).not.toBeInTheDocument();
  });

  it("converts units on request", () => {
    renderFeaturedRoute("/featured/brown-butter-berry-oat-bars");

    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    expect(screen.getByRole("radio", { name: "Metric" })).toHaveAttribute("aria-checked", "true");
  });

  it("scales by servings", () => {
    renderFeaturedRoute("/featured/ginger-sesame-chicken-rice-skillet");

    const stepper = screen.getByRole("group", { name: "Servings" });
    expect(within(stepper).getByRole("spinbutton")).toHaveTextContent("Serves 4");
    for (let index = 0; index < 4; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    }

    expect(within(stepper).getByRole("spinbutton")).toHaveTextContent("Serves 8");
  });

  it("saves the recipe to the cookbook", async () => {
    renderFeaturedRoute("/featured/crisp-cucumber-chickpea-pitas");

    fireEvent.click(screen.getByRole("button", { name: "Save to my cookbook" }));

    expect(await screen.findByRole("button", { name: "In your cookbook" })).toBeInTheDocument();
    const records = fakeIdb.records<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME);
    expect(records.map((record) => record.recipe.title)).toEqual(["Crisp Cucumber Chickpea Pitas"]);
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
    renderFeaturedRoute("/featured/brown-butter-berry-oat-bars");

    expect(screen.getByRole("radio", { name: "Metric" })).toHaveAttribute("aria-checked", "true");
  });

  it.each([
    "classic-sandwich-bread",
    "pizza-crust",
    "classic-chocolate-chip-cookies",
    "banana-bread",
    "jo-mamas-spaghetti",
    "pancakes",
    "barbecue-ribs",
    "oven-crisp-chicken-wings"
  ])("no longer publishes the removed third-party recipe %s", (slug) => {
    renderFeaturedRoute(`/featured/${slug}`);

    expect(screen.getByText("Featured recipe not found")).toBeInTheDocument();
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
