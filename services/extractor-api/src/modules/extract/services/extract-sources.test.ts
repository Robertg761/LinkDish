import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";
import { SocialFetchError } from "../fetchers/errors";

import { buildTextImportSourceUrl, extractRecipe } from "./extract-recipe";

import type {
  ExtractionCandidate,
  ExtractorRuntime,
  FallbackRecipeExtractor,
  FetchResult,
  TextSourceDocument
} from "../types";

const recipeJsonLd = readFileSync(
  new URL("../__fixtures__/recipe-jsonld.html", import.meta.url),
  "utf8"
);
const articleWeak = readFileSync(
  new URL("../__fixtures__/article-weak.html", import.meta.url),
  "utf8"
);
const youtubeTranscript = readFileSync(
  new URL("../__fixtures__/youtube-transcript.txt", import.meta.url),
  "utf8"
);

const htmlResult = (url: string, html: string, finalUrl = url): FetchResult => ({
  document: {
    kind: "html",
    url,
    finalUrl,
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

const llmCandidate = (title = "Caption Chili"): ExtractionCandidate => ({
  recipe: {
    title,
    ingredients: [{ text: "1 lb ground beef" }, { text: "1 can beans" }],
    steps: [{ index: 1, text: "Brown the beef, add the beans and simmer 20 minutes." }],
    servings: null,
    prepTimeMinutes: null,
    cookTimeMinutes: 20,
    nutrition: null
  },
  strategy: "llm-fallback",
  evidence: ["The caption contained a recipe."],
  warnings: [],
  provenance: ["llm"],
  fieldProvenance: {
    title: "llm",
    ingredients: "llm",
    steps: "llm",
    servings: null,
    prepTimeMinutes: null,
    cookTimeMinutes: "llm",
    nutrition: null
  },
  signals: {
    requiredFieldsInferred: false,
    titleConfidence: "strong",
    timesFromStructuredMetadata: false,
    recipeLike: true,
    detectionConfidence: "high",
    sectionCohesion: "medium",
    transcriptQuality: "weak",
    usedBrowserFallback: false,
    blockedSourceSignals: 0
  }
});

const fallbackExtractor = (
  extract: FallbackRecipeExtractor["extract"] = () => Promise.resolve(llmCandidate()),
  available = true
): FallbackRecipeExtractor => ({
  available,
  providerName: available ? "gemini" : "none",
  extract
});

const createRuntime = (overrides: Partial<ExtractorRuntime> = {}): ExtractorRuntime => ({
  fetchImplementation: fetch,
  fetchHtmlDocument: (url: string) => Promise.resolve(htmlResult(url, recipeJsonLd)),
  fetchYouTubeDocument: () => Promise.reject(new Error("unused")),
  fallbackExtractor: fallbackExtractor(),
  validateSourceUrl: () => Promise.resolve({ safe: true }),
  dispose: () => Promise.resolve(),
  ...overrides
});

const tiktokCaption =
  "Easy chili 🌶️ Ingredients: 1 lb ground beef, 1 can beans, 2 tbsp chili powder. Brown the beef, stir in everything and simmer 20 min #dinner #foodtok";

const tiktokDocument = (text = tiktokCaption): TextSourceDocument => ({
  kind: "text",
  url: "https://www.tiktok.com/@cook/video/7234567890123456789",
  origin: "tiktok",
  text,
  title: null,
  authorName: "Cook Creator",
  thumbnailUrl: "https://p16-sign.tiktokcdn.com/thumb.jpeg"
});

describe("redirects that keep the same page", () => {
  it("does not reject an apex to www redirect with a trailing slash", async () => {
    const runtime = createRuntime({
      fetchHtmlDocument: (url: string) =>
        Promise.resolve(
          htmlResult(url, recipeJsonLd, "https://www.fixtures.linkdish.test/recipe-jsonld/")
        )
    });

    const { response } = await extractRecipe(
      { url: "http://fixtures.linkdish.test/recipe-jsonld", attempt: "primary" },
      runtime
    );

    expect(response.status).toBe("success");
  });

  it("ignores 'not found' strings that only appear in scripts", async () => {
    const html = recipeJsonLd.replace(
      "</head>",
      '<script>window.i18n = { error: "Page not found" };</script></head>'
    );
    const runtime = createRuntime({
      fetchHtmlDocument: (url: string) =>
        Promise.resolve(htmlResult(url, html, `${url}-renamed-recipe-jsonld`))
    });

    const { response } = await extractRecipe(
      { url: "https://fixtures.linkdish.test/recipe-jsonld", attempt: "primary" },
      runtime
    );

    expect(response.status).toBe("success");
  });
});

describe("structured recipes with missing metadata", () => {
  it("succeeds with a warning instead of needs_retry", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Quick Slaw",
      recipeIngredient: ["2 cups cabbage", "1 carrot", "2 tbsp mayo"],
      recipeInstructions: ["Toss everything together."]
    })}</script></head><body><h1>Quick Slaw</h1></body></html>`;
    const runtime = createRuntime({
      fetchHtmlDocument: (url: string) => Promise.resolve(htmlResult(url, html))
    });

    const { response } = await extractRecipe(
      { url: "https://fixtures.linkdish.test/quick-slaw", attempt: "primary" },
      runtime
    );

    expect(response).toMatchObject({
      status: "success",
      extraction: {
        strategy: "recipe-schema",
        warnings: ["The source didn't list servings or cooking times."]
      }
    });
  });

  it("fails plainly, without a retry, when the page is weak", async () => {
    const runtime = createRuntime({
      fetchHtmlDocument: (url: string) => Promise.resolve(htmlResult(url, articleWeak))
    });

    const { response } = await extractRecipe(
      { url: "https://fixtures.linkdish.test/article-weak", attempt: "primary" },
      runtime
    );

    expect(response).toMatchObject({ status: "failure", reason: "parse_failed" });
  });

  it("names what is missing when a page lacks part of the recipe", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Thin Soup",
      recipeIngredient: ["1 onion", "4 cups stock"],
      recipeInstructions: []
    })}</script></head><body><h1>Thin Soup</h1></body></html>`;
    const runtime = createRuntime({
      fetchHtmlDocument: (url: string) => Promise.resolve(htmlResult(url, html))
    });

    const { response } = await extractRecipe(
      { url: "https://fixtures.linkdish.test/thin-soup", attempt: "fallback" },
      runtime
    );

    expect(response).toMatchObject({
      status: "failure",
      reason: "parse_failed",
      userMessage: "LinkDish couldn't find the method on that page."
    });
  });
});

describe("Pinterest pins", () => {
  const pinUrl = "https://www.pinterest.com/pin/123456789/";
  const recipeUrl = "https://fixtures.linkdish.test/recipe-jsonld";
  const pinHtml = (seeAlso: string) =>
    `<html><head><meta property="og:see_also" content="${seeAlso}"><title>Pin</title></head><body>A pin</body></html>`;

  it("follows the pin's outbound link and extracts that page", async () => {
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, url === pinUrl ? pinHtml(recipeUrl) : recipeJsonLd))
    );
    const validateSourceUrl = vi.fn(() => Promise.resolve({ safe: true as const }));
    const runtime = createRuntime({ fetchHtmlDocument, validateSourceUrl });

    const { response } = await extractRecipe({ url: pinUrl, attempt: "primary" }, runtime);

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([pinUrl, recipeUrl]);
    expect(validateSourceUrl).toHaveBeenCalledWith(recipeUrl);
    expect(response).toMatchObject({
      status: "success",
      recipe: { title: "One-Pan Tomato Pasta", sourceUrl: recipeUrl }
    });
  });

  it("reads the link from the pin's app state when og:see_also is missing", async () => {
    const appState = `<html><body><script id="__PWS_DATA__" type="application/json">{"pin":{"link":"https:\\/\\/www.pinterest.com\\/other","images":{},"link2":"x"},"x":{"link":"${recipeUrl}"}}</script></body></html>`;
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, url === pinUrl ? appState : recipeJsonLd))
    );

    const { response } = await extractRecipe(
      { url: pinUrl, attempt: "primary" },
      createRuntime({ fetchHtmlDocument })
    );

    expect(fetchHtmlDocument).toHaveBeenLastCalledWith(recipeUrl, expect.any(Object));
    expect(response.status).toBe("success");
  });

  it("never fetches an outbound link that fails URL safety", async () => {
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, pinHtml("http://169.254.169.254/latest/meta-data")))
    );
    const runtime = createRuntime({
      fetchHtmlDocument,
      validateSourceUrl: (url: string) =>
        Promise.resolve(
          url.includes("169.254")
            ? { safe: false as const, reason: "private_address" as const }
            : { safe: true as const }
        )
    });

    await extractRecipe({ url: pinUrl, attempt: "primary" }, runtime);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
  });

  it("resolves pin.it short links that land on a pin", async () => {
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(
        url === "https://pin.it/abc123"
          ? htmlResult(url, pinHtml(recipeUrl), pinUrl)
          : htmlResult(url, recipeJsonLd)
      )
    );

    const { response } = await extractRecipe(
      { url: "https://pin.it/abc123", attempt: "primary" },
      createRuntime({ fetchHtmlDocument })
    );

    expect(response).toMatchObject({ status: "success", recipe: { sourceUrl: recipeUrl } });
  });

  it("serves the pinned recipe from the result cache when it is already there", async () => {
    const extractionCache = createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(10)
    });
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, url === pinUrl ? pinHtml(recipeUrl) : recipeJsonLd))
    );
    const runtime = createRuntime({ fetchHtmlDocument, extractionCache });

    await extractRecipe({ url: recipeUrl, attempt: "primary" }, runtime);
    const { response, logContext } = await extractRecipe(
      { url: pinUrl, attempt: "primary" },
      runtime
    );

    expect(logContext.cacheStatus).toBe("hit");
    expect(response).toMatchObject({ status: "success", recipe: { sourceUrl: recipeUrl } });
    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([recipeUrl, pinUrl]);
  });

  it("reads a linked YouTube video through the YouTube path, not as a web page", async () => {
    const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, pinHtml(videoUrl)))
    );
    const fetchYouTubeDocument = vi.fn<ExtractorRuntime["fetchYouTubeDocument"]>((url, videoId) =>
      Promise.resolve({
        kind: "youtube",
        url,
        videoId,
        title: "Skillet Chicken",
        description: "A quick skillet dinner.",
        transcript: youtubeTranscript,
        chapters: [],
        pageHtml: null
      })
    );

    const extract = vi.fn<FallbackRecipeExtractor["extract"]>();
    const runtime = createRuntime({
      fetchHtmlDocument,
      fetchYouTubeDocument,
      fallbackExtractor: fallbackExtractor(extract)
    });

    const direct = await extractRecipe({ url: videoUrl, attempt: "primary" }, runtime);
    const pinned = await extractRecipe({ url: pinUrl, attempt: "primary" }, runtime);

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([pinUrl]);
    expect(fetchYouTubeDocument).toHaveBeenCalledTimes(2);
    expect(fetchYouTubeDocument).toHaveBeenLastCalledWith(
      videoUrl,
      "dQw4w9WgXcQ",
      expect.any(Object)
    );
    expect(pinned.response.status).not.toBe("failure");
    expect(pinned.response).toEqual(direct.response);
    expect(pinned.logContext.sourceType).toBe("youtube");
    expect(pinned.response).toMatchObject({
      status: "success",
      recipe: { title: "Skillet Chicken", sourceType: "youtube" }
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("reads a linked TikTok through its caption, like a direct TikTok link", async () => {
    const tiktokUrl = "https://www.tiktok.com/@cook/video/7234567890123456789";
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, pinHtml(tiktokUrl)))
    );
    const fetchSocialDocument = vi.fn(() => Promise.resolve(tiktokDocument()));

    const { response } = await extractRecipe(
      { url: pinUrl, attempt: "primary" },
      createRuntime({ fetchHtmlDocument, fetchSocialDocument })
    );

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([pinUrl]);
    expect(fetchSocialDocument).toHaveBeenCalledWith(tiktokUrl, expect.any(Object));
    expect(response).toMatchObject({
      status: "success",
      recipe: { title: "Easy chili", sourceType: "social" }
    });
  });

  it("does not follow an outbound link too long to be a recipe's source URL", async () => {
    const tooLong = `${recipeUrl}?ref=${"a".repeat(2_100)}`;
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, url === pinUrl ? pinHtml(tooLong) : recipeJsonLd))
    );

    const { response } = await extractRecipe(
      { url: pinUrl, attempt: "primary" },
      createRuntime({ fetchHtmlDocument })
    );

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([pinUrl]);
    expect(response.status).not.toBe("success");
  });

  it("rejects a linked social or video site it cannot read without fetching it", async () => {
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, pinHtml("https://www.instagram.com/p/abc123/")))
    );

    const { response } = await extractRecipe(
      { url: pinUrl, attempt: "fallback" },
      createRuntime({ fetchHtmlDocument })
    );

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([pinUrl]);
    expect(response).toMatchObject({ status: "failure", reason: "unsupported_source" });
  });
});

describe("TikTok captions", () => {
  const tiktokUrl = "https://www.tiktok.com/@cook/video/7234567890123456789";

  it("reads the caption's recipe without the LLM, on either attempt", async () => {
    const extract = vi.fn<FallbackRecipeExtractor["extract"]>();
    const runtime = createRuntime({
      fetchSocialDocument: () => Promise.resolve(tiktokDocument()),
      fallbackExtractor: fallbackExtractor(extract)
    });

    const primary = await extractRecipe({ url: tiktokUrl, attempt: "primary" }, runtime);
    const fallback = await extractRecipe({ url: tiktokUrl, attempt: "fallback" }, runtime);

    expect(extract).not.toHaveBeenCalled();
    expect(fallback.response).toEqual(primary.response);
    expect(primary.logContext.sourceType).toBe("social");
    expect(primary.response).toMatchObject({
      status: "success",
      recipe: {
        title: "Easy chili",
        sourceType: "social",
        sourceUrl: tiktokUrl,
        siteName: "TikTok",
        author: "Cook Creator",
        videoUrl: tiktokUrl,
        image: { url: "https://p16-sign.tiktokcdn.com/thumb.jpeg", source: "og" },
        ingredients: [
          { text: "1 lb ground beef" },
          { text: "1 can beans" },
          { text: "2 tbsp chili powder" }
        ],
        steps: [{ index: 1, text: "Brown the beef, stir in everything and simmer 20 min" }]
      },
      extraction: {
        sourceType: "social",
        strategy: "article-pattern",
        provenance: ["visible-text"]
      }
    });
  });

  it("keeps a caption that lists only ingredients and points to the video for the method", async () => {
    const runtime = createRuntime({
      fetchSocialDocument: () =>
        Promise.resolve(
          tiktokDocument("Ingredients:\n2 cups flour\n1 cup sugar\n2 eggs\n#baking #fyp")
        )
    });

    const { response } = await extractRecipe({ url: tiktokUrl, attempt: "primary" }, runtime);

    expect(response).toMatchObject({
      status: "success",
      recipe: {
        title: "TikTok recipe from Cook Creator",
        steps: [{ index: 1, text: "Follow the video for the method." }]
      }
    });
  });

  it("fails without an LLM call when the caption has no recipe", async () => {
    const extract = vi.fn(() => Promise.resolve(llmCandidate()));
    const runtime = createRuntime({
      fetchSocialDocument: () =>
        Promise.resolve(tiktokDocument("best pasta of my life 😍 #foodtok #fyp")),
      fallbackExtractor: fallbackExtractor(extract)
    });

    const { response } = await extractRecipe({ url: tiktokUrl, attempt: "fallback" }, runtime);

    expect(response).toMatchObject({ status: "failure", reason: "parse_failed" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("explains private or removed videos", async () => {
    const runtime = createRuntime({
      fetchSocialDocument: () =>
        Promise.reject(new SocialFetchError("oEmbed 404", "not_found", 404))
    });

    const { response } = await extractRecipe({ url: tiktokUrl, attempt: "primary" }, runtime);

    expect(response).toMatchObject({
      status: "failure",
      reason: "parse_failed",
      userMessage: "That video is private, removed or not available to read."
    });
  });

  it("reads captions with no LLM provider configured", async () => {
    const runtime = createRuntime({
      fetchSocialDocument: () => Promise.resolve(tiktokDocument()),
      fallbackExtractor: fallbackExtractor(undefined, false)
    });

    const { response } = await extractRecipe({ url: tiktokUrl, attempt: "fallback" }, runtime);

    expect(response.status).toBe("success");
  });

  it("stays unsupported for runtimes without a caption reader, and for Instagram", async () => {
    const withoutReader = await extractRecipe(
      { url: tiktokUrl, attempt: "primary" },
      createRuntime()
    );
    const instagram = await extractRecipe(
      { url: "https://www.instagram.com/reel/abc123", attempt: "primary" },
      createRuntime({ fetchSocialDocument: () => Promise.resolve(tiktokDocument()) })
    );

    expect(withoutReader.response).toMatchObject({ reason: "unsupported_source" });
    expect(instagram.response).toMatchObject({ reason: "unsupported_source" });
  });
});

describe("pasted text", () => {
  const recipeText = [
    "Grandma's chili",
    "1 lb ground beef",
    "1 can beans",
    "2 tbsp chili powder",
    "Brown the beef, stir in everything and simmer 20 minutes."
  ].join("\n");

  it("reads pasted text without the LLM, under a stable synthetic source url", async () => {
    const extract = vi.fn<FallbackRecipeExtractor["extract"]>();
    const runtime = createRuntime({ fallbackExtractor: fallbackExtractor(extract) });

    const first = await extractRecipe({ text: recipeText, attempt: "fallback" }, runtime);
    const second = await extractRecipe({ text: recipeText, attempt: "fallback" }, runtime);

    expect(extract).not.toHaveBeenCalled();
    expect(first.response).toMatchObject({
      status: "success",
      recipe: {
        title: "Grandma's chili",
        sourceType: "unknown",
        ingredients: [
          { text: "1 lb ground beef" },
          { text: "1 can beans" },
          { text: "2 tbsp chili powder" }
        ],
        steps: [{ index: 1, text: "Brown the beef, stir in everything and simmer 20 minutes." }]
      },
      extraction: { sourceType: "unknown", strategy: "article-pattern" }
    });
    expect(first.response.status === "success" && first.response.recipe.sourceUrl).toBe(
      buildTextImportSourceUrl(recipeText)
    );
    expect(second.response.status === "success" && second.response.recipe.sourceUrl).toBe(
      buildTextImportSourceUrl(recipeText)
    );
    expect(first.logContext).toMatchObject({ attempt: "primary", cacheStatus: "bypass" });
  });

  it("keeps a provided source url and derives the source type from it", async () => {
    const runtime = createRuntime();

    const { response } = await extractRecipe(
      {
        text: recipeText,
        sourceUrl: "https://www.tiktok.com/@cook/video/1",
        attempt: "fallback"
      },
      runtime
    );

    expect(response).toMatchObject({
      status: "success",
      recipe: { sourceUrl: "https://www.tiktok.com/@cook/video/1", sourceType: "social" }
    });
  });

  it("rejects text without recipe signals", async () => {
    const extract = vi.fn(() => Promise.resolve(llmCandidate()));
    const runtime = createRuntime({ fallbackExtractor: fallbackExtractor(extract) });

    const { response } = await extractRecipe(
      { text: "Thanks for dinner last night, it was lovely to see you all!", attempt: "fallback" },
      runtime
    );

    expect(response).toMatchObject({
      status: "failure",
      reason: "parse_failed",
      recovery: { retryable: false, allowFallback: false }
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it("explains how to label text whose ingredients and steps it cannot tell apart", async () => {
    const { response } = await extractRecipe(
      {
        text: "My chili: brown 1 lb beef with 2 tbsp chili powder, then add 1 can beans and simmer.",
        attempt: "primary"
      },
      createRuntime()
    );

    expect(response).toMatchObject({
      status: "failure",
      reason: "parse_failed",
      userMessage:
        'LinkDish couldn\'t tell the ingredients from the steps. Put the ingredients under an "Ingredients" heading and the steps under a "Method" heading, then try again.'
    });
  });

  it("works with no LLM provider configured", async () => {
    const { response } = await extractRecipe(
      { text: recipeText, attempt: "fallback" },
      createRuntime({ fallbackExtractor: fallbackExtractor(undefined, false) })
    );

    expect(response.status).toBe("success");
  });
});

describe("YouTube recipe links", () => {
  const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const recipeUrl = "https://fixtures.linkdish.test/recipe-jsonld";
  const youtubeDocument = (description: string) =>
    vi.fn<ExtractorRuntime["fetchYouTubeDocument"]>((url, videoId) =>
      Promise.resolve({
        kind: "youtube",
        url,
        videoId,
        title: "Tomato Pasta",
        description,
        transcript: null,
        chapters: [],
        pageHtml: null
      })
    );

  it("reads the written recipe a description links to, keeping the video", async () => {
    const fetchHtmlDocument = vi.fn((url: string) =>
      Promise.resolve(htmlResult(url, recipeJsonLd))
    );
    const validateSourceUrl = vi.fn(() => Promise.resolve({ safe: true as const }));
    const runtime = createRuntime({
      fetchHtmlDocument,
      validateSourceUrl,
      fetchYouTubeDocument: youtubeDocument(
        `My favourite pasta!\nInstagram: https://instagram.com/cook\nFull recipe: ${recipeUrl}`
      )
    });

    const { response } = await extractRecipe({ url: videoUrl, attempt: "primary" }, runtime);

    expect(fetchHtmlDocument.mock.calls.map(([url]) => url)).toEqual([recipeUrl]);
    expect(validateSourceUrl).toHaveBeenCalledWith(recipeUrl);
    expect(response).toMatchObject({
      status: "success",
      recipe: { title: "One-Pan Tomato Pasta", sourceUrl: recipeUrl, videoUrl },
      extraction: { strategy: "recipe-schema" }
    });
  });

  it("explains that the video has no written recipe when neither the description nor a link has one", async () => {
    const fetchHtmlDocument = vi.fn((url: string) => Promise.resolve(htmlResult(url, articleWeak)));
    const runtime = createRuntime({
      fetchHtmlDocument,
      fetchYouTubeDocument: youtubeDocument(`Easy pasta 🍝\nRecipe here: ${recipeUrl}`)
    });

    const { response } = await extractRecipe({ url: videoUrl, attempt: "primary" }, runtime);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      status: "failure",
      reason: "parse_failed",
      userMessage:
        "That video's description doesn't include a written recipe. Try the recipe's website instead."
    });
  });
});
