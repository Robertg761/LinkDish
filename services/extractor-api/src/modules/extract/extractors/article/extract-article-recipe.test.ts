import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractArticleRecipe } from "./extract-article-recipe";

const loadFixture = (fileName: string) =>
  readFileSync(new URL(`../../__fixtures__/${fileName}`, import.meta.url), "utf8");

describe("extractArticleRecipe", () => {
  it("extracts a recipe-like article", () => {
    const candidate = extractArticleRecipe({
      kind: "html",
      url: "https://fixtures.linkdish.test/article-recipe",
      finalUrl: "https://fixtures.linkdish.test/article-recipe",
      html: loadFixture("article-recipe.html"),
      contentType: "text/html",
      title: "Article Recipe Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate?.strategy).toBe("article-pattern");
    expect(candidate?.recipe.ingredients).toHaveLength(4);
    expect(candidate?.recipe.steps?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(candidate?.recipe.image).toEqual({
      height: 800,
      source: "og",
      url: "https://fixtures.linkdish.test/images/cozy-weeknight-soup.jpg",
      width: 1200
    });
    expect(candidate?.recipe.nutrition?.calories).toBe("320 calories");
    expect(candidate?.recipe.nutrition?.protein).toBe("14 g");
  });

  it("returns null when an article is not recipe-like", () => {
    const candidate = extractArticleRecipe({
      kind: "html",
      url: "https://fixtures.linkdish.test/article-no-recipe",
      finalUrl: "https://fixtures.linkdish.test/article-no-recipe",
      html: loadFixture("article-no-recipe.html"),
      contentType: "text/html",
      title: "Article No Recipe Fixture",
      description: null,
      blockedSignals: [],
      statusCode: 200
    });

    expect(candidate).toBeNull();
  });
});
