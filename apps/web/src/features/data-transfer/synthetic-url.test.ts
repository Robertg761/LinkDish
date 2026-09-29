import { paprikaRecipeToRecipe } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import {
  getSyntheticImportLabel,
  isLinkDishInternalSourceUrl,
  isSyntheticImportUrl
} from "./synthetic-url";

describe("synthetic import URLs", () => {
  it("matches the URLs the domain importers make up", () => {
    const { meta } = paprikaRecipeToRecipe({
      name: "Grandma's Shortbread",
      ingredients: "2 cups flour",
      directions: "Bake."
    });

    expect(meta.sourceUrlSynthetic).toBe(true);
    expect(isSyntheticImportUrl(meta.sourceUrl)).toBe(true);
    expect(getSyntheticImportLabel(meta.sourceUrl)).toBe("Imported from Paprika");
  });

  it("labels each app and ignores real links", () => {
    expect(getSyntheticImportLabel("https://linkdish.app/imports/mela/pancakes-1a2b3c4d")).toBe(
      "Imported from Mela"
    );
    expect(getSyntheticImportLabel("https://linkdish.app/imports/schema-org/soup-1a2b3c4d")).toBe(
      "Imported recipe"
    );
    expect(getSyntheticImportLabel("https://www.seriouseats.com/soup")).toBeNull();
    expect(isSyntheticImportUrl("https://www.seriouseats.com/soup")).toBe(false);
    expect(isSyntheticImportUrl(undefined)).toBe(false);
  });

  it("treats photo and pasted-text imports as internal too", () => {
    expect(isLinkDishInternalSourceUrl("https://linkdish.app/image-imports/web-1-abc")).toBe(true);
    expect(isLinkDishInternalSourceUrl("https://linkdish.app/text-imports/web-1-abc")).toBe(true);
    expect(isLinkDishInternalSourceUrl("https://linkdish.app/imports/paprika/x-1")).toBe(true);
    expect(isLinkDishInternalSourceUrl("https://linkdish.ca/starter/soup")).toBe(false);
  });
});
