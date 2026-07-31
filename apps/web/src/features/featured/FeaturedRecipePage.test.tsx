import { render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { FeaturedRecipePage } from "./FeaturedRecipePage";

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: false,
    user: null
  })
}));

vi.mock("../library/saved-recipe-store", () => ({
  forceSaveRecipe: vi.fn(),
  saveRecipe: vi.fn(),
  syncRecipeToHousehold: vi.fn()
}));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({
    requestUpgradeSheet: vi.fn()
  })
}));

const renderFeaturedRoute = (path: string) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/featured/:slug" element={<FeaturedRecipePage />} />
        <Route path="/import" element={<div>Import route</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe("FeaturedRecipePage", () => {
  it("renders a cached featured recipe without starting extraction", () => {
    renderFeaturedRoute("/featured/classic-sandwich-bread");

    expect(screen.getByRole("heading", { name: "Classic Sandwich Bread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save recipe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import another/i })).toBeInTheDocument();
    expect(screen.queryByText(/warming up the oven/i)).not.toBeInTheDocument();
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
