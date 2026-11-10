import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { isStrongPublishedCandidate } from "../confidence/score-recipe";
import { extractRecipeWebpage } from "../extractors/recipe-webpage/extract-recipe-webpage";

import { extractRecipeFromUrl } from "./extract-recipe";
import { createIosSourceRuntime } from "./ios-source-runtime";

import type { ExtractorRuntime, HtmlSourceDocument } from "../types";

const url = "https://publicdomainrecipes.com/basic-waffles/";
const fixture = readFileSync(
  new URL("../__fixtures__/public-domain-waffles.html", import.meta.url),
  "utf8"
);
const document = (html: string, source = url): HtmlSourceDocument => ({
  kind: "html",
  url: source,
  finalUrl: source,
  html,
  title: "Basic Waffles",
  description: null,
  blockedSignals: [],
  statusCode: 200,
  contentType: "text/html"
});

describe("Public Domain Recipes production import regression", () => {
  it("imports the publisher's actual page through the restricted pipeline without Gemini or a browser", async () => {
    const fallback = vi.fn(() => Promise.resolve(null));
    const base = {
      fallbackExtractor: { available: false, providerName: "none", extract: fallback }
    } as unknown as ExtractorRuntime;
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("User-agent: *\nDisallow:\n"))
      .mockResolvedValueOnce(new Response(fixture, { headers: { "content-type": "text/html" } }));
    const runtime = createIosSourceRuntime(base, transport, () => Promise.resolve({ safe: true }));
    const result = await extractRecipeFromUrl({ url, attempt: "primary" }, runtime, {
      cacheMode: "bypass"
    });
    expect(result.response.status).toBe("success");
    if (result.response.status !== "success") throw new Error("Recipe was rejected");
    expect(result.response.recipe.title).toBe("Basic Waffles");
    expect(result.response.recipe.ingredients).toHaveLength(6);
    expect(result.response.recipe.steps).toHaveLength(7);
    expect(result.response.recipe.sourceUrl).toBe(url);
    expect(result.response.recipe.servings).toBeNull();
    expect(result.response.extraction.strategy).toBe("recipe-adapter-dom");
    expect(result.logContext.browserAttempted).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not grant the exception to other publishers or inferred article text", () => {
    const other = extractRecipeWebpage(document(fixture, "https://other.example/basic-waffles/"));
    expect(other).not.toBeNull();
    expect(isStrongPublishedCandidate(other!)).toBe(false);
    const known = extractRecipeWebpage(document(fixture))!;
    expect(isStrongPublishedCandidate(known)).toBe(true);
    expect(isStrongPublishedCandidate({ ...known, strategy: "article-pattern" })).toBe(false);
    expect(
      isStrongPublishedCandidate({
        ...known,
        signals: { ...known.signals, blockedSourceSignals: 1 }
      })
    ).toBe(false);
  });

  it.each([
    fixture.replace('id="ingredients"', 'id="unrelated"'),
    fixture.replace('id="directions"', 'id="unrelated"'),
    fixture.replace("<header><h1>Basic Waffles</h1></header>", "<header></header>")
  ])("does not trust a page when a required explicit section is missing", (html) => {
    const candidate = extractRecipeWebpage(document(html));
    if (candidate) expect(isStrongPublishedCandidate(candidate)).toBe(false);
  });
});
