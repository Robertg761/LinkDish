import { describe, expect, it } from "vitest";

import { shouldUseBrowserFallback } from "./runtime";

describe("shouldUseBrowserFallback", () => {
  it("keeps complete Recipe JSON-LD on the HTTP extraction path", () => {
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: ["captcha", "cloudflare"],
        html: `
          <html>
            <body>Cloudflare captcha integration scripts</body>
            <script type="application/ld+json">
              {
                "@type": "Recipe",
                "name": "French Bread",
                "recipeIngredient": ["flour", "water"],
                "recipeInstructions": [{"@type": "HowToStep", "text": "Mix and bake."}]
              }
            </script>
          </html>
        `
      })
    ).toBe(false);
  });

  it("uses the browser for a genuine challenge page without usable recipe data", () => {
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: ["captcha", "cloudflare", "challenge-title"],
        html: "<html><title>Just a moment...</title><body>Verify you are human.</body></html>"
      })
    ).toBe(true);
  });

  it("keeps complete recipe microdata on the HTTP extraction path", () => {
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: ["cloudflare"],
        html: `
          <article itemtype="https://schema.org/Recipe">
            <span itemprop="recipeIngredient">flour</span>
            <p itemprop="recipeInstructions">Mix and bake.</p>
          </article>
        `
      })
    ).toBe(false);
  });

  it("does not request a browser fallback when the browser is unavailable", () => {
    expect(
      shouldUseBrowserFallback({
        available: false,
        blockedSignals: ["cloudflare"],
        html: "<html><title>Just a moment...</title></html>"
      })
    ).toBe(false);
  });
});
