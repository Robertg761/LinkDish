import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../../app";
import { HtmlFetchError } from "../fetchers";

import type {
  ExtractorRuntime,
  ExtractionCandidate,
  FallbackRecipeExtractor,
  RecipeTextCleaner
} from "../types";

const recipeJsonLd = readFileSync(
  new URL("../__fixtures__/recipe-jsonld.html", import.meta.url),
  "utf8"
);
const articleWeak = readFileSync(
  new URL("../__fixtures__/article-weak.html", import.meta.url),
  "utf8"
);
const articleRecipe = readFileSync(
  new URL("../__fixtures__/article-recipe.html", import.meta.url),
  "utf8"
);
const youtubeTranscript = readFileSync(
  new URL("../__fixtures__/youtube-transcript.txt", import.meta.url),
  "utf8"
);

const createFallbackExtractor = (
  candidate: ExtractionCandidate | null,
  available = true
): FallbackRecipeExtractor => ({
  available,
  providerName: available ? "gemini" : "none",
  extract: () => Promise.resolve(candidate)
});

const createRuntime = (options?: {
  fallbackCandidate?: ExtractionCandidate | null;
  fallbackAvailable?: boolean;
  recipeTextCleaner?: RecipeTextCleaner;
}): ExtractorRuntime => ({
  fetchImplementation: fetch,
  fetchHtmlDocument: (url: string) =>
    Promise.resolve({
      document: {
        kind: "html",
        url,
        finalUrl: url,
        html: url.includes("recipe-jsonld")
          ? recipeJsonLd
          : url.includes("article-recipe")
            ? articleRecipe
            : articleWeak,
        contentType: "text/html",
        title: "Fixture HTML",
        description: null,
        blockedSignals: [],
        statusCode: 200
      },
      mode: "http",
      blockedSignals: []
    }),
  fetchYouTubeDocument: (url: string, videoId: string) =>
    Promise.resolve({
      kind: "youtube",
      url,
      videoId,
      title: "Skillet Chicken",
      description: "A quick skillet dinner.",
      transcript: youtubeTranscript,
      chapters: [],
      pageHtml: null
    }),
  fallbackExtractor: createFallbackExtractor(
    options?.fallbackCandidate ?? null,
    options?.fallbackAvailable ?? false
  ),
  ...(options?.recipeTextCleaner ? { recipeTextCleaner: options.recipeTextCleaner } : {}),
  validateSourceUrl: () => Promise.resolve({ safe: true }),
  dispose: () => Promise.resolve()
});

describe("POST /extract", () => {
  it("returns success for a structured recipe page", async () => {
    const app = buildApp({
      runtime: createRuntime()
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/recipe-jsonld"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "success",
      recipe: {
        title: "One-Pan Tomato Pasta",
        sourceType: "recipe-webpage",
        image: {
          height: 900,
          source: "jsonld",
          url: "https://cdn.example.test/images/tomato-pasta.jpg",
          width: 1200
        }
      }
    });
  });

  it("preserves captured OpenGraph image metadata when fallback builds the recipe", async () => {
    const app = buildApp({
      runtime: createRuntime({
        fallbackAvailable: true,
        fallbackCandidate: {
          recipe: {
            title: "Fallback Cozy Soup",
            ingredients: [{ text: "1 can white beans" }],
            steps: [{ index: 1, text: "Simmer the soup." }],
            servings: "4 servings",
            prepTimeMinutes: 10,
            cookTimeMinutes: 20,
            nutrition: null
          },
          strategy: "llm-fallback",
          evidence: ["Fallback model assembled a complete recipe."],
          warnings: [],
          provenance: ["llm"],
          fieldProvenance: {
            title: "llm",
            ingredients: "llm",
            steps: "llm",
            servings: "llm",
            prepTimeMinutes: "llm",
            cookTimeMinutes: "llm",
            nutrition: null
          },
          signals: {
            requiredFieldsInferred: false,
            titleConfidence: "strong",
            timesFromStructuredMetadata: false,
            recipeLike: true,
            detectionConfidence: "medium",
            sectionCohesion: "medium",
            transcriptQuality: "weak",
            usedBrowserFallback: false,
            blockedSourceSignals: 0
          }
        }
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/article-recipe",
        attempt: "fallback"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "success",
      recipe: {
        title: "Fallback Cozy Soup",
        image: {
          height: 800,
          source: "og",
          url: "https://fixtures.linkdish.test/images/cozy-weeknight-soup.jpg",
          width: 1200
        }
      }
    });
  });

  it("cleans successful structured recipe text before returning it", async () => {
    const clean = vi.fn<RecipeTextCleaner["clean"]>().mockImplementation((recipe) =>
      Promise.resolve({
        ...recipe,
        title: "Clean One-Pan Tomato Pasta"
      })
    );
    const app = buildApp({
      runtime: createRuntime({
        recipeTextCleaner: {
          available: true,
          providerName: "gemini",
          clean
        }
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/recipe-jsonld"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(clean).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      status: "success",
      recipe: {
        title: "Clean One-Pan Tomato Pasta"
      }
    });
  });

  it("returns needs_retry when the deterministic pass is too weak", async () => {
    const app = buildApp({
      runtime: createRuntime()
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/article-weak"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "needs_retry"
    });
  });

  it("returns unsupported_source for unsupported inputs", async () => {
    const app = buildApp({
      runtime: createRuntime()
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://www.instagram.com/reel/abc123"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "unsupported_source"
    });
  });

  it("returns unsupported_source for video links before fetching media metadata", async () => {
    const app = buildApp({
      runtime: {
        ...createRuntime(),
        fetchYouTubeDocument: () => {
          throw new Error("Unsupported video URLs must not be fetched.");
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://www.youtube.com/shorts/abc123"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "unsupported_source",
      userMessage:
        "Video links and shorts are not supported yet. Paste a written recipe page instead.",
      recovery: {
        allowFallback: false,
        retryable: false,
        suggestedAction: "try_another_url"
      }
    });
  });

  it("rejects unsafe source URLs before fetching them", async () => {
    const runtime = {
      ...createRuntime(),
      fetchHtmlDocument: () => {
        throw new Error("Unsafe URLs must not be fetched.");
      },
      validateSourceUrl: () =>
        Promise.resolve({
          reason: "private_address" as const,
          safe: false as const
        })
    };
    const app = buildApp({
      runtime
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "http://169.254.169.254/latest/meta-data"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "unsupported_source"
    });
  });

  it("returns fallback success when extra cleanup works", async () => {
    const clean = vi.fn<RecipeTextCleaner["clean"]>().mockImplementation((recipe) =>
      Promise.resolve({
        ...recipe,
        title: "Clean Fallback Skillet Chicken"
      })
    );
    const app = buildApp({
      runtime: createRuntime({
        recipeTextCleaner: {
          available: true,
          providerName: "gemini",
          clean
        },
        fallbackCandidate: {
          recipe: {
            title: "Fallback Skillet Chicken",
            ingredients: [{ text: "1 lb chicken thighs" }],
            steps: [{ index: 1, text: "Sear the chicken." }],
            servings: "4 servings",
            prepTimeMinutes: 10,
            cookTimeMinutes: 18,
            nutrition: null
          },
          strategy: "llm-fallback",
          evidence: ["Fallback model assembled a complete recipe."],
          warnings: [],
          provenance: ["llm"],
          fieldProvenance: {
            title: "llm",
            ingredients: "llm",
            steps: "llm",
            servings: "llm",
            prepTimeMinutes: "llm",
            cookTimeMinutes: "llm",
            nutrition: null
          },
          signals: {
            requiredFieldsInferred: false,
            titleConfidence: "strong",
            timesFromStructuredMetadata: false,
            recipeLike: true,
            detectionConfidence: "medium",
            sectionCohesion: "medium",
            transcriptQuality: "weak",
            usedBrowserFallback: false,
            blockedSourceSignals: 0
          }
        },
        fallbackAvailable: true
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/article-weak",
        attempt: "fallback"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(clean).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      status: "success",
      recipe: {
        title: "Clean Fallback Skillet Chicken"
      },
      extraction: {
        strategy: "llm-fallback"
      }
    });
  });

  it("returns fallback success for recipe images without fetching a URL", async () => {
    const clean = vi.fn<RecipeTextCleaner["clean"]>().mockImplementation((recipe) =>
      Promise.resolve({
        ...recipe,
        title: "Clean Scanned Skillet Chicken"
      })
    );
    const fallbackExtract = vi.fn<FallbackRecipeExtractor["extract"]>().mockResolvedValue({
      recipe: {
        title: "Scanned Skillet Chicken",
        ingredients: [{ text: "1 lb chicken thighs" }],
        steps: [{ index: 1, text: "Sear the chicken." }],
        servings: "4 servings",
        prepTimeMinutes: 10,
        cookTimeMinutes: 18,
        nutrition: null
      },
      strategy: "llm-fallback",
      evidence: ["Image text contained a complete recipe."],
      warnings: [],
      provenance: ["llm"],
      fieldProvenance: {
        title: "llm",
        ingredients: "llm",
        steps: "llm",
        servings: "llm",
        prepTimeMinutes: "llm",
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
    const app = buildApp({
      runtime: {
        ...createRuntime(),
        fetchHtmlDocument: () => {
          throw new Error("Image extraction must not fetch HTML.");
        },
        fallbackExtractor: {
          available: true,
          providerName: "gemini",
          extract: fallbackExtract
        },
        recipeTextCleaner: {
          available: true,
          providerName: "gemini",
          clean
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        images: [
          {
            dataUrl: "data:image/jpeg;base64,abc123",
            mimeType: "image/jpeg"
          }
        ],
        sourceUrl: "https://linkdish.app/image-imports/test",
        attempt: "fallback"
      }
    });

    expect(response.statusCode).toBe(200);
    const fallbackInput = fallbackExtract.mock.calls[0]?.[0];
    expect(fallbackInput?.sourceType).toBe("image");
    expect(fallbackInput?.sourceDocument.kind).toBe("image");
    expect(clean).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      status: "success",
      recipe: {
        title: "Clean Scanned Skillet Chicken",
        sourceType: "image",
        sourceUrl: "https://linkdish.app/image-imports/test"
      },
      extraction: {
        sourceType: "image",
        strategy: "llm-fallback"
      }
    });
  });

  it("returns fallback_unavailable when OpenAI is not configured", async () => {
    const app = buildApp({
      runtime: createRuntime({
        fallbackCandidate: null,
        fallbackAvailable: false
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/article-weak",
        attempt: "fallback"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "fallback_unavailable"
    });
  });

  it("returns parse_failed when the source page no longer exists", async () => {
    const app = buildApp({
      runtime: {
        ...createRuntime(),
        fetchHtmlDocument: () =>
          Promise.reject(
            new HtmlFetchError(
              "Missing page.",
              "not_found",
              [],
              404,
              "https://fixtures.linkdish.test/missing"
            )
          )
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/missing"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "parse_failed"
    });
  });

  it("returns parse_failed when a URL redirects to unrelated content", async () => {
    const app = buildApp({
      runtime: {
        ...createRuntime(),
        fetchHtmlDocument: (url: string) =>
          Promise.resolve({
            document: {
              kind: "html",
              url,
              finalUrl: "https://fixtures.linkdish.test/unrelated-page",
              html: "<html><title>Totally Different Page</title><main>Nothing about oats here.</main></html>",
              contentType: "text/html",
              title: "Totally Different Page",
              description: null,
              blockedSignals: [],
              statusCode: 200
            },
            mode: "http",
            blockedSignals: []
          })
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "https://fixtures.linkdish.test/how-to-make-oatmeal"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "failure",
      reason: "parse_failed"
    });
  });

  it("returns 400 for invalid requests", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/extract",
      payload: {
        url: "bad-url"
      }
    });

    expect(response.statusCode).toBe(400);
  });
});
