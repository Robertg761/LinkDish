import { act, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { useRecipeMenuExtras } from "./recipe-menu-extras";

import type { RecipeMenuExtras } from "./recipe-menu-extras";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

vi.mock("../collections/CollectionPickerSheet", () => ({
  CollectionPickerSheet: ({ recipeIds }: { recipeIds: readonly string[] }) => (
    <div role="dialog">Collections for {recipeIds.join(",")}</div>
  )
}));
vi.mock("../collections/TagEditorSheet", () => ({
  TagEditorSheet: ({ recipeId }: { recipeId: string }) => (
    <div role="dialog">Tags for {recipeId}</div>
  )
}));
vi.mock("../plan/AddToPlanSheet", () => ({
  AddToPlanSheet: ({ recipeTitle }: { recipeTitle: string }) => (
    <div role="dialog">Plan {recipeTitle}</div>
  )
}));

const savedRecipe = {
  id: "recipe-1",
  recipe: { title: "Banana Bread" }
} as unknown as WebSavedRecipe;

let latest: RecipeMenuExtras | null = null;

const Probe: React.FC<{ recipe: WebSavedRecipe | null }> = ({ recipe }) => {
  const extras = useRecipeMenuExtras(recipe);
  latest = extras;
  return <>{extras.elements}</>;
};

describe("useRecipeMenuExtras", () => {
  it("offers nothing on household-shared routes", () => {
    render(
      <MemoryRouter>
        <Probe recipe={null} />
      </MemoryRouter>
    );

    expect(latest?.items).toEqual([]);
  });

  it("adds meal plan, collection and tag entries that open their sheets", async () => {
    render(
      <MemoryRouter>
        <Probe recipe={savedRecipe} />
      </MemoryRouter>
    );

    const labels = latest?.items.map((item) => ("label" in item ? item.label : item.id));
    expect(labels).toEqual(["Add to meal plan…", "Add to collection…", "Edit tags…"]);

    const collections = latest?.items.find((item) => item.id === "add-to-collection");
    act(() => {
      if (collections && "onSelect" in collections) {
        collections.onSelect();
      }
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Collections for recipe-1");

    const plan = latest?.items.find((item) => item.id === "add-to-plan");
    act(() => {
      if (plan && "onSelect" in plan) {
        plan.onSelect();
      }
    });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Plan Banana Bread");
  });
});
