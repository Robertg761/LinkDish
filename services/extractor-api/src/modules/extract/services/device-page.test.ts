import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { extractRecipeAnyRequestSchema } from "../../../../../../packages/api-contracts/src/index";
import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";
import { HtmlFetchError } from "../fetchers/errors";

import { extractRecipe } from "./extract-recipe";

import type { ExtractorRuntime, FetchResult } from "../types";

const recipeJsonLd = readFileSync(
  new URL("../__fixtures__/recipe-jsonld.html", import.meta.url),
  "utf8"
);
const articleWeak = readFileSync(
  new URL("../__fixtures__/article-weak.html", import.meta.url),
  "utf8"
);

const recipeUrl = "https://www.allrecipes.com/recipe/13309/rich-and-simple-french-onion-soup/";
/* What Allrecipes answers every cloud server with. */
const paymentRequired = () =>
  Promise.reject(
    new HtmlFetchError("Failed to fetch HTML document: 402", "blocked", [], 402, recipeUrl)
  );

const htmlResult = (url: string, html: string): FetchResult => ({
  document: {
    kind: "html",
    url,
    finalUrl: url,
    html,
    contentType: "text/html",
    title: null,
    description: null,
    blockedSignals: [],
    statusCode: 200
  },
  mode: "http",
  blockedSignals: []
});

const createRuntime = (overrides: Partial<ExtractorRuntime> = {}): ExtractorRuntime => ({
  fetchImplementation: fetch,
  fetchHtmlDocument: paymentRequired,
  fetchYouTubeDocument: () => Promise.reject(new Error("unused")),
  fallbackExtractor: { available: false, providerName: "none", extract: vi.fn() },
  validateSourceUrl: () => Promise.resolve({ safe: true }),
  dispose: () => Promise.resolve(),
  ...overrides
});

describe("sites that block LinkDish's servers", () => {
  it("tells the client it may download a blocked web page itself", async () => {
    const { response } = await extractRecipe(
      { url: recipeUrl, attempt: "primary" },
      createRuntime()
    );

    expect(response).toMatchObject({
      status: "failure",
      reason: "source_blocked",
      deviceFetchAvailable: true,
      userMessage: expect.stringContaining("Paste text") as string
    });
  });

  it("does not offer a device download for a pin whose outbound page is blocked", async () => {
    const pinUrl = "https://www.pinterest.com/pin/123456789/";
    const pinHtml = `<html><head><title>Pin</title><link rel="canonical" href="${pinUrl}"><meta property="og:see_also" content="${recipeUrl}"></head><body><a href="${recipeUrl}">Visit site</a></body></html>`;
    const { response } = await extractRecipe(
      { url: pinUrl, attempt: "primary" },
      createRuntime({
        fetchHtmlDocument: (url: string) =>
          url === pinUrl ? Promise.resolve(htmlResult(url, pinHtml)) : paymentRequired()
      })
    );

    expect(response).toMatchObject({ status: "failure", reason: "source_blocked" });
    expect(response).not.toHaveProperty("deviceFetchAvailable");
  });

  it("never sends a device after a redirect the server refused as unsafe", async () => {
    const { response } = await extractRecipe(
      { url: recipeUrl, attempt: "primary" },
      createRuntime({
        fetchHtmlDocument: () =>
          Promise.reject(
            new HtmlFetchError(
              "Refused unsafe redirect target: private_address",
              "blocked",
              ["unsafe_redirect:private_address"],
              302,
              "http://192.168.1.1/"
            )
          )
      })
    );

    expect(response).toMatchObject({ status: "failure", reason: "source_blocked" });
    expect(response).not.toHaveProperty("deviceFetchAvailable");
  });

  it("reads the page the device downloaded without fetching it again", async () => {
    const fetchHtmlDocument = vi.fn(paymentRequired);
    const { response, logContext } = await extractRecipe(
      { url: recipeUrl, attempt: "primary", devicePage: { html: recipeJsonLd } },
      createRuntime({ fetchHtmlDocument })
    );

    expect(fetchHtmlDocument).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      status: "success",
      recipe: { title: "One-Pan Tomato Pasta", sourceUrl: recipeUrl },
      extraction: { strategy: "recipe-schema", fetchMode: "http" }
    });
    expect(logContext).toMatchObject({ pageSource: "device", cacheStatus: "bypass" });
  });

  it("never reads or writes the shared result cache with a device page", async () => {
    const extractionCache = createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(10)
    });
    const read = vi.spyOn(extractionCache, "read");
    const write = vi.spyOn(extractionCache, "write");

    const { response } = await extractRecipe(
      { url: recipeUrl, attempt: "primary", devicePage: { html: recipeJsonLd } },
      createRuntime({ extractionCache }),
      { schedule: (task) => void task }
    );

    expect(response.status).toBe("success");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("still applies URL safety to a device page", async () => {
    const { response } = await extractRecipe(
      { url: recipeUrl, attempt: "primary", devicePage: { html: recipeJsonLd } },
      createRuntime({
        validateSourceUrl: () => Promise.resolve({ safe: false, reason: "private_address" })
      })
    );

    expect(response).toMatchObject({ status: "failure", reason: "unsupported_source" });
  });

  it("fails plainly when the device page has no recipe", async () => {
    const { response } = await extractRecipe(
      { url: recipeUrl, attempt: "primary", devicePage: { html: articleWeak } },
      createRuntime()
    );

    expect(response.status).toBe("failure");
    expect(response).not.toHaveProperty("deviceFetchAvailable");
  });

  it("parses a device page request rather than dropping its page", () => {
    const parsed = extractRecipeAnyRequestSchema.parse({
      url: recipeUrl,
      devicePage: { html: "<html></html>", finalUrl: recipeUrl }
    });

    expect(parsed).toMatchObject({
      url: recipeUrl,
      attempt: "primary",
      devicePage: { html: "<html></html>" }
    });
  });
});
