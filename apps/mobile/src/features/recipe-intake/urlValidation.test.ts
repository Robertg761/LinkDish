import { describe, expect, it } from "vitest";

import { isAllowedRecipeUrl, resolveRecipeUrlInput } from "./urlValidation";

describe("resolveRecipeUrlInput", () => {
  it("keeps a plain recipe URL as typed", () => {
    expect(resolveRecipeUrlInput("  https://site.com/recipe?id=4  ")).toBe(
      "https://site.com/recipe?id=4"
    );
  });

  it("pulls the link out of a pasted social caption", () => {
    expect(
      resolveRecipeUrlInput(
        "Best crispy tofu ever 😍 https://www.tiktok.com/@cook/video/123 #dinner"
      )
    ).toBe("https://www.tiktok.com/@cook/video/123");
    expect(resolveRecipeUrlInput("www.site.com/soup")).toBe("https://www.site.com/soup");
  });

  it("rejects text without a usable link", () => {
    expect(resolveRecipeUrlInput("")).toBeNull();
    expect(resolveRecipeUrlInput("chicken soup")).toBeNull();
    expect(resolveRecipeUrlInput("ftp://site.com/recipe")).toBeNull();
    expect(isAllowedRecipeUrl("javascript:alert(1)")).toBe(false);
  });
});
