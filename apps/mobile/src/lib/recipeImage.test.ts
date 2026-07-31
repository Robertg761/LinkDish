import { describe, expect, it } from "vitest";

import { buildProxiedRecipeImageUrl, getRecipeMonogram } from "./recipeImage";

describe("recipe image helpers", () => {
  it("builds extractor proxy image URLs at the requested width", () => {
    expect(
      buildProxiedRecipeImageUrl(
        {
          height: 720,
          source: "og",
          url: "https://example.com/recipe image.jpg?size=large",
          width: 960
        },
        480
      )
    ).toBe(
      "http://localhost:3000/image?url=https%3A%2F%2Fexample.com%2Frecipe+image.jpg%3Fsize%3Dlarge&w=480"
    );
  });

  it("returns null without image metadata", () => {
    expect(buildProxiedRecipeImageUrl(null, 96)).toBeNull();
  });

  it("uses a decoded first alphanumeric recipe title character for monograms", () => {
    expect(getRecipeMonogram("&quot;apple tart&quot;")).toBe("A");
  });
});
