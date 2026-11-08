import { describe, expect, it } from "vitest";

import { featuredRecipes, LINKDISH_OWNED_SOURCE_PATTERN } from "./featured-recipes";

describe("featuredRecipes", () => {
  it("publishes only LinkDish's own recipes, never another site's recipe or photo", () => {
    expect(featuredRecipes.length).toBeGreaterThan(0);

    for (const featured of featuredRecipes) {
      expect(featured.sourceUrl).toMatch(LINKDISH_OWNED_SOURCE_PATTERN);
      expect(featured.recipe.sourceUrl).toMatch(LINKDISH_OWNED_SOURCE_PATTERN);
      // A LinkDish recipe carries no third-party photo (the starters have none).
      expect(featured.recipe.image).toBeNull();
    }
  });

  it("no longer contains the King Arthur Baking or Food.com recipes", () => {
    const serialized = JSON.stringify(featuredRecipes).toLowerCase();

    expect(serialized).not.toContain("kingarthurbaking");
    expect(serialized).not.toContain("food.com");
    expect(serialized).not.toContain("sndimg");
  });

  it("has unique slugs", () => {
    const slugs = featuredRecipes.map((featured) => featured.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
