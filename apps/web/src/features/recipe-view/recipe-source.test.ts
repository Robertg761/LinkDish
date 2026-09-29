import { describe, expect, it } from "vitest";

import { getRecipeSourceInfo } from "./recipe-source";

describe("getRecipeSourceInfo", () => {
  it("links real recipe pages", () => {
    expect(
      getRecipeSourceInfo("https://www.seriouseats.com/banana-bread", {
        sourceHost: "seriouseats.com"
      })
    ).toEqual({
      href: "https://www.seriouseats.com/banana-bread",
      kind: "web",
      label: "seriouseats.com",
      shareUrl: "https://www.seriouseats.com/banana-bread"
    });
  });

  it("never links or shares made-up LinkDish addresses", () => {
    const cases = [
      ["https://linkdish.app/image-imports/web-1-abc", "photos", "From your photos"],
      ["https://linkdish.app/text-imports/abc123", "text", "From pasted text"],
      [
        "https://linkdish.app/imports/paprika/banana-bread-1a2b",
        "imported",
        "Imported from Paprika"
      ],
      ["https://linkdish.app/imports/mela/soup-9f", "imported", "Imported from Mela"],
      ["https://linkdish.app/imports/schema-org/stew-77", "imported", "Imported recipe"]
    ] as const;

    for (const [url, kind, label] of cases) {
      expect(getRecipeSourceInfo(url, { sourceHost: "linkdish.app" })).toEqual({
        href: null,
        kind,
        label,
        shareUrl: null
      });
    }
  });
});
