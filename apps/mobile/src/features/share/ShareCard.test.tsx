import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Image: (props: Record<string, unknown>) => React.createElement("Image", props),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("View", props, children)
}));

vi.mock("@linkdish/ui", () => ({
  AppText: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("AppText", props, children)
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#29443b",
    accentSoft: "#dde7df",
    background: "#f4efe7",
    muted: "#6e685f",
    text: "#1f211d"
  }
}));

vi.mock("../../lib/recipeImage", () => ({
  buildProxiedRecipeImageUrl: (image: Recipe["image"] | null | undefined) =>
    image ? "https://images.linkdish.test/recipe.jpg" : null
}));

import { ShareCard } from "./ShareCard";

import type { Recipe } from "@linkdish/recipe-domain";

type ShareCardTestImage = Exclude<Recipe["image"], undefined>;

const buildRecipe = (image: ShareCardTestImage): Recipe => ({
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: null,
      ingredients: "visible-text",
      nutrition: null,
      prepTimeMinutes: null,
      servings: null,
      steps: "visible-text",
      title: "visible-text"
    },
    missingFields: [],
    notes: [],
    score: 0.9,
    summary: "Confident extraction."
  },
  cookTimeMinutes: null,
  image,
  ingredients: [{ text: "1 cup stock" }],
  nutrition: null,
  prepTimeMinutes: null,
  servings: null,
  sourceType: "article",
  sourceUrl: "https://example.com/soup",
  steps: [{ index: 1, text: "Simmer." }],
  title: "Velvet Soup"
});

describe("ShareCard", () => {
  it.each([
    [
      "image",
      { source: "og", url: "https://example.com/soup.jpg" } satisfies ShareCardTestImage
    ],
    ["text-only", null]
  ])("renders the LinkDish footer in the %s variant", (_variant, image) => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<ShareCard recipe={buildRecipe(image)} sourceLabel="Example Kitchen" />);
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Made with LinkDish · linkdish.ca");
  });
});
