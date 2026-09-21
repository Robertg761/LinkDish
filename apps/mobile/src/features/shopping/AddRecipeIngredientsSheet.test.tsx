import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shoppingMocks = vi.hoisted(() => ({
  addItems: vi.fn()
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("@linkdish/ui", () => ({
  appColors: {
    accent: "#29443b",
    accentSoft: "#dde7df",
    background: "#f4efe7",
    border: "#ddd2c3",
    canvas: "#fbf7f0",
    muted: "#6e685f",
    surface: "#fffdf8",
    text: "#1f211d"
  },
  appShadows: { card: {} },
  appSpacing: { lg: 16, md: 12, sm: 8, xl: 20, xs: 4, xxl: 24 },
  AppButton: ({ disabled, label, onPress }: { disabled?: boolean; label: string; onPress: () => void }) =>
    React.createElement("AppButton", { disabled, label, onPress }, label),
  AppSurface: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("AppText", null, children)
}));

vi.mock("react-native", () => ({
  Modal: ({ children, visible }: { children?: React.ReactNode; visible: boolean }) =>
    visible ? React.createElement("Modal", null, children) : null,
  Pressable: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("pressable", props, children),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("ScrollView", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  View: ({ children }: { children?: React.ReactNode }) => React.createElement("View", null, children)
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("SafeAreaView", null, children)
}));

vi.mock("./ShoppingListContext", () => ({
  useShoppingList: () => shoppingMocks
}));

import { AddRecipeIngredientsSheet } from "./AddRecipeIngredientsSheet";

import type { Recipe } from "@linkdish/recipe-domain";
import type { ReactTestInstance } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recipe: Recipe = {
  title: "Soup",
  sourceUrl: "https://example.com/soup",
  sourceType: "article",
  image: null,
  ingredients: [{ text: "2 cups stock" }, { text: "1 onion" }, { text: "Salt to taste" }],
  steps: [{ index: 1, text: "Cook." }],
  servings: "4 servings",
  prepTimeMinutes: 10,
  cookTimeMinutes: 20,
  nutrition: null,
  confidence: {
    score: 0.9,
    summary: "Confident extraction.",
    missingFields: [],
    notes: [],
    fieldProvenance: {
      title: "visible-text",
      ingredients: "visible-text",
      steps: "visible-text",
      servings: "visible-text",
      prepTimeMinutes: "visible-text",
      cookTimeMinutes: "visible-text",
      nutrition: null
    }
  }
};

const getCheckedLabels = (renderer: ReturnType<typeof create>): string[] =>
  renderer.root
    .findAllByType("pressable" as React.ElementType)
    .filter(
      (node: ReactTestInstance) =>
        (node.props as { accessibilityState?: { checked?: boolean } }).accessibilityState
          ?.checked === true
    )
    .map((node: ReactTestInstance) => String((node.props as { accessibilityLabel: string }).accessibilityLabel));

describe("AddRecipeIngredientsSheet", () => {
  beforeEach(() => {
    shoppingMocks.addItems.mockReset();
  });

  it("keeps manual deselections when the recipe scale changes", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <AddRecipeIngredientsSheet
          onClose={() => undefined}
          recipe={recipe}
          recipeId="recipe_1"
          scaleFactor={1}
          unitMode="original"
          visible
        />
      );
    });

    expect(getCheckedLabels(renderer!)).toHaveLength(3);

    const onionRow = renderer!.root
      .findAllByType("pressable" as React.ElementType)
      .find((node: ReactTestInstance) =>
        String((node.props as { accessibilityLabel?: string }).accessibilityLabel ?? "").includes(
          "onion"
        )
      );

    act(() => {
      (onionRow!.props as { onPress: () => void }).onPress();
    });

    expect(getCheckedLabels(renderer!)).toHaveLength(2);

    act(() => {
      renderer!.update(
        <AddRecipeIngredientsSheet
          onClose={() => undefined}
          recipe={recipe}
          recipeId="recipe_1"
          scaleFactor={2}
          unitMode="original"
          visible
        />
      );
    });

    expect(getCheckedLabels(renderer!)).toHaveLength(2);

    act(() => {
      (
        renderer!.root.findByProps({ label: "Add 2 items" }).props as { onPress: () => void }
      ).onPress();
    });

    expect(shoppingMocks.addItems).toHaveBeenCalledTimes(1);
    expect(
      (shoppingMocks.addItems.mock.calls[0]?.[0] as Array<{ text: string }>).map(
        (item) => item.text
      )
    ).not.toContain("2 onions");
  });

  it("re-selects everything when the sheet is reopened", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <AddRecipeIngredientsSheet
          onClose={() => undefined}
          recipe={recipe}
          recipeId="recipe_1"
          scaleFactor={1}
          unitMode="original"
          visible
        />
      );
    });

    const firstRow = renderer!.root.findAllByType("pressable" as React.ElementType)[1];

    act(() => {
      (firstRow!.props as { onPress: () => void }).onPress();
    });

    expect(getCheckedLabels(renderer!)).toHaveLength(2);

    act(() => {
      renderer!.update(
        <AddRecipeIngredientsSheet
          onClose={() => undefined}
          recipe={recipe}
          recipeId="recipe_1"
          scaleFactor={1}
          unitMode="original"
          visible={false}
        />
      );
    });

    act(() => {
      renderer!.update(
        <AddRecipeIngredientsSheet
          onClose={() => undefined}
          recipe={recipe}
          recipeId="recipe_1"
          scaleFactor={1}
          unitMode="original"
          visible
        />
      );
    });

    expect(getCheckedLabels(renderer!)).toHaveLength(3);
  });
});
