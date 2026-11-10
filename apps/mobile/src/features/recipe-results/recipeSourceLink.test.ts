import { describe, expect, it } from "vitest";

import { getRecipeSourceLink } from "./recipeSourceLink";

describe("getRecipeSourceLink", () => {
  it("links a recipe saved from a web page to its original page", () => {
    expect(getRecipeSourceLink("https://www.seriouseats.com/best-chili")).toEqual({
      byline: null,
      href: "https://www.seriouseats.com/best-chili",
      label: "seriouseats.com"
    });
  });

  it("shows the stored site name and author when the page gave them", () => {
    expect(
      getRecipeSourceLink("https://www.example.com/pie", {
        author: "  Jane   Baker ",
        siteName: "Example Kitchen"
      })
    ).toEqual({
      byline: "By Jane Baker",
      href: "https://www.example.com/pie",
      label: "Example Kitchen"
    });
  });

  it("falls back to the host when the stored site name is blank", () => {
    expect(getRecipeSourceLink("https://m.example.com/pie", { siteName: "   " }).label).toBe(
      "example.com"
    );
  });

  it("links video sources too", () => {
    expect(getRecipeSourceLink("https://www.tiktok.com/@cook/video/123").href).toBe(
      "https://www.tiktok.com/@cook/video/123"
    );
  });

  it("never links photo scans, pasted text, app imports or starters", () => {
    expect(getRecipeSourceLink("https://linkdish.app/image-imports/abc")).toEqual({
      byline: null,
      href: null,
      label: "Scanned image"
    });
    expect(getRecipeSourceLink("https://linkdish.app/text-imports/abc").href).toBeNull();
    expect(getRecipeSourceLink("https://linkdish.app/imports/paprika/soup-1a").label).toBe(
      "Imported from Paprika"
    );
    expect(getRecipeSourceLink("https://linkdish.app/imports/paprika/soup-1a").href).toBeNull();
    expect(getRecipeSourceLink("https://linkdish.ca/starter/brown-butter-berry-oat-bars")).toEqual({
      byline: null,
      href: null,
      label: "LinkDish kitchen"
    });
  });

  it("never links non-web or missing sources", () => {
    expect(getRecipeSourceLink(undefined)).toEqual({
      byline: null,
      href: null,
      label: "No source provided"
    });
    expect(getRecipeSourceLink("javascript:alert(1)").href).toBeNull();
    expect(getRecipeSourceLink("nonsense").href).toBeNull();
  });
});
