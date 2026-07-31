import { describe, expect, it } from "vitest";

import { buildRecipeImageUrl, getRecipeImageOrNull, getRecipeMonogram } from "./recipe-image";

import type { RecipeImage } from "@linkdish/recipe-domain";

describe("recipe-image", () => {
  const image: RecipeImage = {
    height: 900,
    source: "og",
    url: "https://example.com/photos/lemon pasta.jpg?size=large",
    width: 1200
  };

  it("builds proxied extractor image URLs with the requested width", () => {
    expect(buildRecipeImageUrl(image, 480, "/api")).toBe(
      "/api/image?url=https%3A%2F%2Fexample.com%2Fphotos%2Flemon+pasta.jpg%3Fsize%3Dlarge&w=480"
    );
  });

  it("returns null when a recipe has no image metadata", () => {
    expect(buildRecipeImageUrl(null, 96, "/api")).toBeNull();
    expect(getRecipeImageOrNull(undefined)).toBeNull();
  });

  it("derives a quiet monogram fallback from the recipe title", () => {
    expect(getRecipeMonogram("  cherry pie")).toBe("C");
    expect(getRecipeMonogram("")).toBe("L");
  });
});
