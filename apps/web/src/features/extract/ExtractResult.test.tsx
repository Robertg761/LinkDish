import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveRecipe } from "../library/saved-recipe-store";

import { ExtractResult } from "./ExtractResult";

import type { Recipe } from "@linkdish/recipe-domain";

const authMocks = vi.hoisted(() => ({
  user: {
    billingPlan: "plus",
    email: "cook@example.com",
    id: "user_1"
  } as {
    billingPlan?: "free" | "plus" | "family";
    email: string;
    id: string;
  }
}));

const upgradeMocks = vi.hoisted(() => ({
  requestUpgradeSheet: vi.fn()
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: authMocks.user
  })
}));

vi.mock("../library/saved-recipe-store", () => ({
  forceSaveRecipe: vi.fn(),
  saveRecipe: vi.fn(),
  syncRecipeToHousehold: vi.fn()
}));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({
    requestUpgradeSheet: upgradeMocks.requestUpgradeSheet
  })
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

describe("ExtractResult", () => {
  beforeEach(() => {
    authMocks.user = {
      billingPlan: "plus",
      email: "cook@example.com",
      id: "user_1"
    };
    vi.mocked(saveRecipe).mockReset();
    upgradeMocks.requestUpgradeSheet.mockReset();
  });

  it("renders recipe details as a quiet meta line", () => {
    render(
      <ExtractResult
        recipe={recipe}
        sourceUrl="https://example.com/rice"
        extraction={{
          fetchMode: "http",
          provenance: ["jsonld"],
          strategy: "recipe-schema",
          warnings: []
        }}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByText("Webpage · 4 servings · Prep 5 min · Cook 20 min")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toHaveAttribute("href", "https://example.com/rice");
    expect(screen.getByRole("article", { name: "Personal Rice" }).closest(".card")).toBeNull();
    expect(screen.getByRole("heading", { name: "Ingredients" }).closest(".card")).toBeNull();
    expect(screen.getByRole("heading", { name: "Method" }).closest(".card")).toBeNull();
    expect(screen.queryByText("Recipe Webpage")).not.toBeInTheDocument();
    expect(screen.queryByText("Recipe Preview")).not.toBeInTheDocument();
    expect(screen.queryByText("4 servings servings")).not.toBeInTheDocument();
  });

  it("opens the save-limit upgrade sheet when the free cookbook is full", async () => {
    authMocks.user = {
      billingPlan: "free",
      email: "cook@example.com",
      id: "user_1"
    };
    vi.mocked(saveRecipe).mockResolvedValue({
      error: "limit_exceeded",
      success: false
    });

    render(
      <ExtractResult
        recipe={recipe}
        sourceUrl="https://example.com/rice"
        extraction={{
          fetchMode: "http",
          provenance: ["jsonld"],
          strategy: "recipe-schema",
          warnings: []
        }}
        onReset={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /save recipe/i }));

    expect(
      await screen.findByText(
        "Your free cookbook is full - 15 recipes saved. Upgrade for unlimited saved recipes."
      )
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("save_limit");
    });
  });
});
