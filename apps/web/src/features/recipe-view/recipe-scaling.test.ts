import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesForTests, setPreference } from "../../preferences/preferences-store";

import {
  formatScaleFactor,
  getDisplayStepText,
  getScaledIngredientText,
  parseScaleFactor,
  splitIngredientQuantity,
  useRecipeScaling
} from "./recipe-scaling";

import type { Recipe } from "@linkdish/recipe-domain";

const bread: Pick<Recipe, "ingredients" | "servings"> = {
  ingredients: [
    { text: "3 cups (360g) all-purpose flour" },
    { text: "2 cups flour" },
    { text: "1 tsp salt" },
    { text: "Salt to taste" }
  ],
  servings: "4 servings"
};

describe("recipe scaling helpers", () => {
  it("reads custom factors people type", () => {
    expect(parseScaleFactor("1.5")).toBe(1.5);
    expect(parseScaleFactor("1,5")).toBe(1.5);
    expect(parseScaleFactor("3/2")).toBe(1.5);
    expect(parseScaleFactor("½")).toBe(0.5);
    expect(parseScaleFactor("2x")).toBe(2);
    expect(parseScaleFactor("")).toBeNull();
    expect(parseScaleFactor("0")).toBeNull();
    expect(parseScaleFactor("abc")).toBeNull();
    expect(parseScaleFactor("2abc")).toBeNull();
    expect(parseScaleFactor("500")).toBe(20);
  });

  it("formats factors for chips", () => {
    expect(formatScaleFactor(0.5)).toBe("½×");
    expect(formatScaleFactor(1)).toBe("1×");
    expect(formatScaleFactor(1.5)).toBe("1.5×");
  });

  it("keeps the legacy getScaledIngredientText contract and adds units", () => {
    expect(getScaledIngredientText("1 cup flour", { factor: 2 })).toBe("2 cups flour");
    expect(getScaledIngredientText("Salt to taste", { factor: 2 })).toBe("Salt to taste");
    expect(getScaledIngredientText("2 cups flour", { factor: 1, units: "metric" })).toBe(
      "240 g flour"
    );
  });

  it("converts step temperatures only when a system is chosen", () => {
    expect(getDisplayStepText("Heat the oven to 350°F.", "original")).toBe(
      "Heat the oven to 350°F."
    );
    expect(getDisplayStepText("Heat the oven to 350°F.", "metric")).toBe("Heat the oven to 175°C.");
  });

  it("splits the leading amount so it can be set in bold figures", () => {
    expect(splitIngredientQuantity("3 cups (360 g) flour")).toEqual({
      quantity: "3 cups",
      rest: " (360 g) flour"
    });
    expect(splitIngredientQuantity("½ to ⅔ cup hot water")).toEqual({
      quantity: "½ to ⅔ cup",
      rest: " hot water"
    });
    expect(splitIngredientQuantity("2 garlic cloves")).toEqual({
      quantity: "2",
      rest: " garlic cloves"
    });
    expect(splitIngredientQuantity("Salt to taste")).toEqual({
      quantity: "",
      rest: "Salt to taste"
    });
  });
});

describe("useRecipeScaling", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPreferencesForTests();
  });

  it("scales by servings and remembers the choice per recipe", () => {
    const onPreferredServingsChange = vi.fn();
    const { result } = renderHook(() => useRecipeScaling(bread, { onPreferredServingsChange }));

    expect(result.current.targetServings).toBe(4);
    expect(result.current.servingsLabel).toBe("Serves 4");

    act(() => result.current.setServings(8));

    expect(result.current.state.factor).toBe(2);
    expect(result.current.servingsLabel).toBe("Serves 8");
    expect(result.current.displayIngredient("1 tsp salt").text).toBe("2 tsp salt");
    expect(result.current.isModified).toBe(true);
    expect(onPreferredServingsChange).toHaveBeenLastCalledWith(8);

    act(() => result.current.setServings(4));
    expect(onPreferredServingsChange).toHaveBeenLastCalledWith(null);
  });

  it("starts from the saved servings", () => {
    const { result } = renderHook(() => useRecipeScaling(bread, { preferredServings: 6 }));

    expect(result.current.targetServings).toBe(6);
    expect(result.current.state.factor).toBe(1.5);
  });

  it("defaults units to the preference and lets the page override them", () => {
    setPreference("units", "metric");
    const { result } = renderHook(() => useRecipeScaling(bread));

    expect(result.current.units).toBe("metric");
    expect(result.current.displayIngredient("2 cups flour")).toMatchObject({
      approximate: true,
      text: "240 g flour"
    });
    expect(result.current.isModified).toBe(false);

    act(() => result.current.setUnits("original"));
    expect(result.current.units).toBe("original");
    expect(result.current.isModified).toBe(true);

    act(() => result.current.reset());
    expect(result.current.units).toBe("metric");
  });

  it("keeps the original units when converting would change nothing", () => {
    setPreference("units", "metric");
    const { result } = renderHook(() =>
      useRecipeScaling({ ingredients: [{ text: "2 eggs" }, { text: "Salt" }], servings: null })
    );

    expect(result.current.summary.canConvert).toBe(false);
    expect(result.current.units).toBe("original");
  });

  it("scales by factor when there is no servings count", () => {
    const { result } = renderHook(() =>
      useRecipeScaling({ ingredients: [{ text: "1 cup rice" }], servings: null })
    );

    act(() => result.current.setCustomFactor("1.5"));
    expect(result.current.state).toMatchObject({ customFactor: "1.5", factor: 1.5 });

    act(() => result.current.setCustomFactor("oops"));
    expect(result.current.state).toMatchObject({ customFactor: "oops", factor: 1.5 });

    act(() => result.current.setFactor(2));
    expect(result.current.displayIngredient("1 cup rice").text).toBe("2 cups rice");
  });
});
