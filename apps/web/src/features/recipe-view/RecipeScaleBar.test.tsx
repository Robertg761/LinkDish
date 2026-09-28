import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { useRecipeScaling } from "./recipe-scaling";
import { RecipeScaleBar } from "./RecipeScaleBar";

import type { Recipe } from "@linkdish/recipe-domain";

const ScaleBar: React.FC<{ servings: string | null }> = ({ servings }) => {
  const scaling = useRecipeScaling({
    ingredients: [{ text: "2 cups flour" }, { text: "1 tsp salt" }] as Recipe["ingredients"],
    servings
  });

  return <RecipeScaleBar scaling={scaling} />;
};

describe("RecipeScaleBar", () => {
  it("uses one stepper for any yield with a count, named after what it makes", () => {
    render(<ScaleBar servings="10 slices" />);

    const value = screen.getByRole("spinbutton", { name: "Amount" });
    expect(value).toHaveTextContent("10 slices");
    fireEvent.click(screen.getByRole("button", { name: "Increase amount" }));
    expect(value).toHaveTextContent("11 slices");
    expect(screen.queryByRole("radiogroup", { name: "Recipe scale" })).not.toBeInTheDocument();
  });

  it("keeps the Serves stepper for servings", () => {
    render(<ScaleBar servings="Serves 4" />);

    expect(screen.getByRole("spinbutton", { name: "Servings" })).toHaveTextContent("Serves 4");
  });

  it("falls back to batch chips for a yield without a count, with an 'Other' field", () => {
    render(<ScaleBar servings={null} />);

    const custom = screen.getByRole("textbox", { name: "Custom recipe scale" });
    expect(custom).toHaveAttribute("placeholder", "Other");
    // No trailing "×" that reads like a remove button until there is a number.
    expect(custom.closest("label")).not.toHaveTextContent("×");

    fireEvent.change(custom, { target: { value: "1.5" } });
    expect(custom.closest("label")).toHaveTextContent("×");
    expect(custom.closest("label")).toHaveClass("is-active");
  });
});
