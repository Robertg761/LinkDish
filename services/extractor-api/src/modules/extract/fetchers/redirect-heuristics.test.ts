import { describe, expect, it } from "vitest";

import {
  getRegistrableDomain,
  isKnownLinkShortener,
  isSameRegistrableDomain
} from "../source-detection/registrable-domain";

import { looksLikeUnrelatedRedirect } from "./shared";

const recipePage = `<html><head><title>Classic Lasagna</title></head><body>${"<p>Layer the pasta, sauce and cheese, then bake until bubbling.</p>".repeat(
  60
)}</body></html>`;

const redirect = (requestedUrl: string, finalUrl: string, html = recipePage, title?: string) =>
  looksLikeUnrelatedRedirect({ requestedUrl, finalUrl, title: title ?? null, html });

describe("registrable domains", () => {
  it("groups hosts by the label under the public suffix", () => {
    expect(getRegistrableDomain("www.allrecipes.com")).toBe("allrecipes.com");
    expect(getRegistrableDomain("recipes.bbcgoodfood.co.uk")).toBe("bbcgoodfood.co.uk");
    expect(getRegistrableDomain("www.taste.com.au")).toBe("taste.com.au");
    expect(getRegistrableDomain("www.example.co")).toBe("example.co");
    expect(getRegistrableDomain("GrandmasKitchen.blogspot.com.")).toBe(
      "grandmaskitchen.blogspot.com"
    );
    expect(getRegistrableDomain("203.0.113.10")).toBe("203.0.113.10");
  });

  it("compares sites, not hosts", () => {
    expect(isSameRegistrableDomain("allrecipes.com", "www.allrecipes.com")).toBe(true);
    expect(isSameRegistrableDomain("a.blogspot.com", "b.blogspot.com")).toBe(false);
    expect(isSameRegistrableDomain("example.com", "example.com.evil.test")).toBe(false);
  });

  it("knows the common link shorteners", () => {
    for (const host of ["pin.it", "bit.ly", "t.co", "tinyurl.com", "www.tinyurl.com", "ow.ly"]) {
      expect(isKnownLinkShortener(host)).toBe(true);
    }

    for (const host of ["buff.ly", "lnkd.in", "linktr.ee"]) {
      expect(isKnownLinkShortener(host)).toBe(true);
    }

    expect(isKnownLinkShortener("allrecipes.com")).toBe(false);
  });
});

describe("looksLikeUnrelatedRedirect", () => {
  it("accepts redirects that keep the page's address", () => {
    expect(
      redirect(
        "https://allrecipes.com/recipe/1/lasagna",
        "https://www.allrecipes.com/recipe/1/lasagna"
      )
    ).toBe(false);
    expect(
      redirect("http://www.example.com/classic-lasagna", "https://www.example.com/classic-lasagna/")
    ).toBe(false);
    expect(
      redirect(
        "https://example.com/classic-lasagna?utm_source=pinterest",
        "https://example.com/classic-lasagna"
      )
    ).toBe(false);
  });

  it("accepts subdomain moves within one site", () => {
    expect(
      redirect("https://example.com/classic-lasagna", "https://recipes.example.com/classic-lasagna")
    ).toBe(false);
  });

  it("lets link shorteners send people to another site", () => {
    expect(redirect("https://pin.it/abc123", "https://www.example.com/classic-lasagna")).toBe(
      false
    );
    expect(redirect("https://bit.ly/3xYz", "https://www.example.com/classic-lasagna")).toBe(false);
  });

  it("flags cross-site redirects from ordinary sites", () => {
    expect(
      redirect("https://example.com/classic-lasagna", "https://spam.example.net/classic-lasagna")
    ).toBe(true);
  });

  it("flags deep links that land on the homepage", () => {
    expect(redirect("https://example.com/classic-lasagna", "https://www.example.com/")).toBe(true);
  });

  it("flags unrelated paths on the same site", () => {
    expect(
      redirect("https://example.com/how-to-make-oatmeal", "https://example.com/unrelated-page")
    ).toBe(true);
  });

  it("reads 'not found' only from the title or readable text", () => {
    const scriptOnly = recipePage.replace(
      "</head>",
      '<script>var messages = { missing: "not found", gone: "Page not found" };</script></head>'
    );

    expect(
      redirect(
        "https://example.com/classic-lasagna",
        "https://example.com/classic-lasagna-2",
        scriptOnly
      )
    ).toBe(false);
    expect(
      redirect(
        "https://example.com/classic-lasagna",
        "https://example.com/classic-lasagna-2",
        recipePage,
        "Page not found"
      )
    ).toBe(true);
    expect(
      redirect(
        "https://example.com/classic-lasagna",
        "https://example.com/classic-lasagna-2",
        "<html><body><h1>Sorry, that recipe was not found</h1></body></html>"
      )
    ).toBe(true);
  });

  it("still honours hint text on a shortener redirect", () => {
    expect(
      redirect(
        "https://bit.ly/3xYz",
        "https://www.example.com/somewhere",
        "<html><body><h1>This recipe has moved</h1></body></html>"
      )
    ).toBe(true);
  });
});
