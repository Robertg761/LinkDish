import { describe, expect, it } from "vitest";

import { shouldUseBrowserFallback } from "./browser-escalation";

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

  it("never uses the browser to get past a challenge or block page", () => {
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: ["captcha", "cloudflare", "challenge-title"],
        html: "<html><title>Just a moment...</title><body>Verify you are human.</body></html>"
      })
    ).toBe(false);
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: ["status:403"],
        html: "<html><body></body></html>"
      })
    ).toBe(false);
  });

  it("still renders a JavaScript shell that the site served normally", () => {
    expect(
      shouldUseBrowserFallback({
        available: true,
        blockedSignals: [],
        html: '<html><head><title>Recipe</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
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
