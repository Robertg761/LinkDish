import { describe, expect, it } from "vitest";

import { canonicalizeSourceUrl, hashCanonicalSourceUrl, isSameSiteFetch } from "./canonical-url";

describe("canonicalizeSourceUrl", () => {
  it("drops tracking parameters, fragments and trailing slashes and lowercases the host", () => {
    expect(
      canonicalizeSourceUrl(
        "https://WWW.Example.com/Recipes/Tomato-Soup/?utm_source=pin&UTM_Medium=social&fbclid=abc&gclid=1&igshid=2&mc_cid=3&mc_eid=4&si=5#comments"
      )
    ).toBe("https://www.example.com/Recipes/Tomato-Soup");
  });

  it("keeps meaningful query parameters and their order", () => {
    expect(canonicalizeSourceUrl("https://example.com/recipe?id=42&utm_campaign=x&print=1")).toBe(
      "https://example.com/recipe?id=42&print=1"
    );
  });

  it("maps every YouTube URL form for one video to the same key", () => {
    const canonical = "https://www.youtube.com/watch?v=abc123DEF45";

    expect(canonicalizeSourceUrl("https://youtu.be/abc123DEF45?si=share")).toBe(canonical);
    expect(canonicalizeSourceUrl("https://m.youtube.com/watch?v=abc123DEF45&t=30s")).toBe(
      canonical
    );
    expect(hashCanonicalSourceUrl("https://www.youtube.com/watch?v=abc123DEF45#t=1")).toBe(
      hashCanonicalSourceUrl(canonical)
    );
  });

  it("keeps the root path and the scheme", () => {
    expect(canonicalizeSourceUrl("http://example.com/")).toBe("http://example.com/");
    expect(canonicalizeSourceUrl("https://example.com")).not.toBe(
      canonicalizeSourceUrl("http://example.com")
    );
  });
});

describe("isSameSiteFetch", () => {
  it("accepts same-page, apex/www and subdomain redirects", () => {
    expect(isSameSiteFetch("https://example.com/a?utm_source=x", "https://example.com/a")).toBe(
      true
    );
    expect(
      isSameSiteFetch("https://allrecipes.com/recipe/1", "https://www.allrecipes.com/recipe/1")
    ).toBe(true);
    expect(
      isSameSiteFetch("https://example.com/r/1", "https://recipes.example.com/tomato-soup")
    ).toBe(true);
    expect(isSameSiteFetch("http://example.com/a", "https://example.com/b")).toBe(true);
  });

  it("rejects redirects to another site, including sibling subdomains of shared hosts", () => {
    expect(isSameSiteFetch("https://example.com/recipe", "https://evil.test/recipe")).toBe(false);
    expect(isSameSiteFetch("https://a.blogspot.com/post", "https://b.blogspot.com/post")).toBe(
      false
    );
    expect(isSameSiteFetch("https://example.com/recipe", "not a url")).toBe(false);
  });
});
