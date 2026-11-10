import { describe, expect, it } from "vitest";

import { getRecipeSourceRestriction, isSupportedIosRecipeUrl } from "./iosRecipeSources";

describe("iPhone recipe source policy", () => {
  it.each([
    "https://publicdomainrecipes.com/basic-waffles/",
    "https://publicdomainrecipes.com/banana-bread/#ingredients"
  ])("allows a recipe on a reviewed source: %s", (url) => {
    expect(isSupportedIosRecipeUrl(url)).toBe(true);
  });

  it.each([
    "https://www.tiktok.com/@cook/video/1",
    "https://based.cooking/basic-waffles/",
    "https://publicdomainrecipes.com.evil.example/basic-waffles/",
    "https://publicdomainrecipes.com@evil.example/basic-waffles/",
    "https://evil.example@publicdomainrecipes.com/basic-waffles/",
    "https://www.publicdomainrecipes.com/basic-waffles/",
    "https://publicdomainrecipes.com:8443/basic-waffles/",
    "http://publicdomainrecipes.com/basic-waffles/",
    "https://publicdomainrecipes.com/redirect/?url=https://evil.example",
    "https://publicdomainrecipes.com/basic-waffles/?next=https://evil.example",
    "https://publicdomainrecipes.com/%2f%2fevil.example/",
    "https://publicdomainrecipes.com/tags/",
    "https://publicdomainrecipes.com/tags/dinner/",
    "https://publicdomainrecipes.com/",
    "https://127.0.0.1/basic-waffles/",
    "javascript:alert(1)"
  ])("rejects unreviewed or non-recipe URLs: %s", (url) => {
    expect(getRecipeSourceRestriction(url, "ios")).toContain("On iPhone");
  });

  it("does not change Android or web link imports", () => {
    for (const platform of ["android", "web"]) {
      expect(getRecipeSourceRestriction("https://example.com/recipe", platform)).toBeNull();
    }
  });
});
