import { describe, expect, it } from "vitest";

import { extractUrlFromSharedText } from "./sharedText";

describe("extractUrlFromSharedText", () => {
  it("extracts a URL from share text with surrounding copy", () => {
    expect(extractUrlFromSharedText("Check this out https://site.com/recipe amazing!")).toBe(
      "https://site.com/recipe"
    );
  });

  it("returns undefined when shared text has no URL", () => {
    expect(extractUrlFromSharedText("This recipe was excellent, but there is no link.")).toBe(
      undefined
    );
  });

  it("removes common trailing punctuation copied with a shared URL", () => {
    expect(extractUrlFromSharedText("Try https://site.com/recipe.")).toBe(
      "https://site.com/recipe"
    );
  });
});
