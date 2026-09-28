import { describe, expect, it } from "vitest";

import {
  canonicalizeRecipeUrl,
  extractFirstUrl,
  isLikelySameRecipe,
  recipeSourceLabel,
  recipeUrlIdentity
} from "./index.js";

describe("canonicalizeRecipeUrl", () => {
  const corpus: ReadonlyArray<readonly [string, string]> = [
    [
      "https://www.Example.com/Recipes/Lemon-Pasta/?utm_source=fb&utm_medium=social&fbclid=abc#comments",
      "https://www.example.com/Recipes/Lemon-Pasta"
    ],
    ["http://example.com:80/a/", "http://example.com/a"],
    ["https://example.com:443", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com/recipe?b=2&a=1&gclid=x", "https://example.com/recipe?a=1&b=2"],
    [
      "https://example.com/r?si=abc&igshid=x&mc_cid=1&mc_eid=2&ref_src=twsrc&utm_campaign=y",
      "https://example.com/r"
    ],
    ["https://example.com//recipes//x", "https://example.com/recipes/x"],
    ["https://example.com:8080/x", "https://example.com:8080/x"],
    ["  https://example.com/x  ", "https://example.com/x"],
    ["https://example.com/x?print=1#recipe", "https://example.com/x?print=1"],
    ["not a url", "not a url"],
    ["javascript:alert(1)", "javascript:alert(1)"]
  ];

  it("canonicalizes the labelled corpus", () => {
    expect(corpus).toHaveLength(12);

    for (const [input, expected] of corpus) {
      expect(canonicalizeRecipeUrl(input), input).toBe(expected);
    }
  });

  it("is idempotent", () => {
    for (const [input] of corpus) {
      const once = canonicalizeRecipeUrl(input);
      expect(canonicalizeRecipeUrl(once), input).toBe(once);
    }
  });
});

describe("isLikelySameRecipe", () => {
  it("ignores tracking, www/m/amp variants and trailing slashes", () => {
    expect(
      isLikelySameRecipe("https://www.site.com/recipe/?utm_source=x", "https://site.com/recipe")
    ).toBe(true);
    expect(isLikelySameRecipe("https://m.site.com/recipe", "https://site.com/recipe/amp/")).toBe(
      true
    );
    expect(isLikelySameRecipe("http://site.com/recipe", "https://site.com/recipe#step-2")).toBe(
      true
    );
    expect(isLikelySameRecipe("https://site.com/recipe", "https://site.com/other-recipe")).toBe(
      false
    );
    expect(isLikelySameRecipe("https://site.com/recipe", "https://other.com/recipe")).toBe(false);
  });

  it("recognizes the same YouTube video in any link form", () => {
    const watch = "https://www.youtube.com/watch?v=abc123XYZ_-&t=30s";

    expect(isLikelySameRecipe(watch, "https://youtu.be/abc123XYZ_-?si=share")).toBe(true);
    expect(isLikelySameRecipe(watch, "https://m.youtube.com/shorts/abc123XYZ_-")).toBe(true);
    expect(isLikelySameRecipe(watch, "https://www.youtube.com/embed/abc123XYZ_-")).toBe(true);
    expect(isLikelySameRecipe(watch, "https://youtu.be/zzz999")).toBe(false);
    expect(recipeUrlIdentity(watch)).toBe("youtube:abc123XYZ_-");
  });

  it("treats the same title on the same site as the same recipe", () => {
    expect(
      isLikelySameRecipe(
        { sourceUrl: "https://site.com/lemon-pasta?print=1", title: "Lemon Pasta!" },
        { sourceUrl: "https://www.site.com/recipes/lemon-pasta", title: "lemon pasta" }
      )
    ).toBe(true);
    expect(
      isLikelySameRecipe(
        { sourceUrl: "https://site.com/lemon-pasta", title: "Lemon Pasta" },
        { sourceUrl: "https://other.com/lemon-pasta-2", title: "Lemon Pasta" }
      )
    ).toBe(false);
    expect(
      isLikelySameRecipe({ sourceUrl: "https://site.com/a", title: "" }, "https://site.com/a")
    ).toBe(true);
  });
});

describe("extractFirstUrl", () => {
  const corpus: ReadonlyArray<readonly [string, string | null]> = [
    ["Look at this! https://site.com/recipe.", "https://site.com/recipe"],
    ["(see https://site.com/recipe)", "https://site.com/recipe"],
    [
      "https://en.wikipedia.org/wiki/Pavlova_(cake)",
      "https://en.wikipedia.org/wiki/Pavlova_(cake)"
    ],
    ["Try www.site.com/x!", "https://www.site.com/x"],
    ['Shared: "https://site.com/a?b=1"', "https://site.com/a?b=1"],
    ["https://site.com/recipe?x=1;", "https://site.com/recipe?x=1"],
    ["Two links https://a.com/1 and https://b.com/2", "https://a.com/1"],
    ["Recipe:https://site.com/r'", "https://site.com/r"],
    ["no link here", null],
    ["ftp://files.example.com/x", null],
    ["", null]
  ];

  it("extracts the first link from shared text", () => {
    expect(corpus).toHaveLength(11);

    for (const [text, expected] of corpus) {
      expect(extractFirstUrl(text), text).toBe(expected);
    }
  });
});

describe("recipeSourceLabel", () => {
  it("labels where a recipe came from", () => {
    expect(recipeSourceLabel("https://www.seriouseats.com/x")).toBe("seriouseats.com");
    expect(recipeSourceLabel("https://linkdish.app/image-imports/abc")).toBe("Scanned image");
    expect(recipeSourceLabel("nonsense")).toBe("Saved recipe");
    expect(recipeSourceLabel("https://linkdish.app/text-imports/abc123")).toBe("Pasted text");
    expect(recipeSourceLabel("https://linkdish.app/imports/paprika/banana-bread-1a2b")).toBe(
      "Imported from Paprika"
    );
    expect(recipeSourceLabel("https://linkdish.app/imports/mela/soup-9f")).toBe(
      "Imported from Mela"
    );
    expect(recipeSourceLabel("https://linkdish.app/imports/schema-org/stew-77")).toBe(
      "Imported recipe"
    );
  });
});
