import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";
import { createFallbackHandoffStore } from "../cache/fallback-handoff";
import { ExtractionCancelledError } from "../deadline";

import { extractRecipe, FALLBACK_HANDOFF_MAX_WAIT_MS } from "./extract-recipe";

import type { FallbackHandoffStore } from "../cache/fallback-handoff";
import type {
  ExtractionCandidate,
  ExtractorRuntime,
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

const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";

const fallbackCandidate: ExtractionCandidate = {
  recipe: {
    title: "Fallback Skillet Dinner",
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
};

const createTestRuntime = (
  options: {
    fallbackAvailable?: boolean;
    finalUrl?: (url: string) => string;
    fallbackExtract?: FallbackRecipeExtractor["extract"];
    refresh?: FallbackRecipeExtractor["refresh"];
    cleaner?: RecipeTextCleaner;
  } = {}
) => {
  const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>((url: string) =>
    Promise.resolve({
      document: {
        kind: "html" as const,
        url,
        finalUrl: options.finalUrl?.(url) ?? url,
        html: url.includes("recipe-jsonld") ? recipeJsonLd : articleWeak,
        contentType: "text/html",
        title: "Fixture HTML",
        description: null,
        blockedSignals: [],
        statusCode: 200
      },
      mode: "http" as const,
      blockedSignals: []
    })
  );
  const fallbackExtract = vi.fn<FallbackRecipeExtractor["extract"]>(
    options.fallbackExtract ?? (() => Promise.resolve(fallbackCandidate))
  );
  const fallbackExtractor: FallbackRecipeExtractor = {
    available: options.fallbackAvailable ?? true,
    providerName: options.fallbackAvailable === false ? "none" : "gemini",
    extract: fallbackExtract,
    ...(options.refresh ? { refresh: options.refresh } : {})
  };
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument,
    fetchYouTubeDocument: () => Promise.reject(new Error("YouTube is not used here.")),
    fallbackExtractor,
    ...(options.cleaner ? { recipeTextCleaner: options.cleaner } : {}),
    extractionCache: createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(50)
    }),
    fallbackHandoffStore: createFallbackHandoffStore({ store: createMemoryCacheStore(50) }),
    validateSourceUrl: vi.fn(() => Promise.resolve({ safe: true as const })),
    dispose: () => Promise.resolve()
  };

  return { runtime, fetchHtmlDocument, fallbackExtract };
};

describe("extraction result cache in the extract pipeline", () => {
  it("serves a repeat import from the cache without fetching, re-stamping the caller's URL", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime();

    const first = await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/recipe-jsonld?utm_source=pin" },
      runtime
    );
    const second = await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/recipe-jsonld/?fbclid=abc" },
      runtime
    );

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(first.logContext.cacheStatus).toBe("miss");
    expect(second.logContext).toMatchObject({
      cacheStatus: "hit",
      attempt: "primary",
      browserAttempted: false,
      outcomeStatus: "success",
      strategy: "recipe-schema"
    });
    expect(second.response).toEqual({
      ...first.response,
      recipe: {
        ...(first.response.status === "success" ? first.response.recipe : {}),
        sourceUrl: "https://fixtures.linkdish.test/recipe-jsonld/?fbclid=abc"
      }
    });
  });

  it("does not cache needs_retry results", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime();

    const first = await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/article-weak" },
      runtime
    );
    await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/article-weak" },
      runtime
    );

    expect(first.response.status).toBe("needs_retry");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
  });

  it("does not cache a page that redirected to a different site", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime({
      finalUrl: (url) => url.replace("fixtures.linkdish.test", "unrelated.example")
    });
    const url = "https://fixtures.linkdish.test/recipe-jsonld";

    await extractRecipe({ attempt: "primary", url }, runtime);
    const second = await extractRecipe({ attempt: "primary", url }, runtime);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(second.logContext.cacheStatus).toBe("miss");
  });

  it("keeps the routes of a hash-routed app apart in the cache", async () => {
    const lemonChicken = recipeJsonLd
      .replaceAll("One-Pan Tomato Pasta", "Lemon Chicken")
      .replace("12 oz spaghetti", "2 chicken breasts");
    /* Playwright's page.goto keeps the fragment, so the app renders that route's recipe. */
    const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>((url: string) =>
      Promise.resolve({
        document: {
          kind: "html" as const,
          url,
          finalUrl: url,
          html: new URL(url).hash === "#/recipe/2" ? lemonChicken : recipeJsonLd,
          contentType: "text/html",
          title: null,
          description: null,
          blockedSignals: [],
          statusCode: 200
        },
        mode: "browser" as const,
        blockedSignals: []
      })
    );
    const { runtime: baseRuntime } = createTestRuntime();
    const runtime: ExtractorRuntime = { ...baseRuntime, fetchHtmlDocument };

    const first = await extractRecipe(
      { attempt: "primary", url: "https://spa.example/#/recipe/1" },
      runtime
    );
    const second = await extractRecipe(
      { attempt: "primary", url: "https://spa.example/#/recipe/2" },
      runtime
    );

    expect(first.response).toMatchObject({ recipe: { title: "One-Pan Tomato Pasta" } });
    expect(second.logContext.cacheStatus).toBe("miss");
    expect(second.response).toMatchObject({
      status: "success",
      recipe: { title: "Lemon Chicken", sourceUrl: "https://spa.example/#/recipe/2" }
    });
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
  });

  it("skips cache reads in refresh mode (live canary) but still stores the fresh result", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime();
    const url = "https://fixtures.linkdish.test/recipe-jsonld";

    const refreshed = await extractRecipe({ attempt: "primary", url }, runtime, {
      cacheMode: "refresh"
    });
    const cached = await extractRecipe({ attempt: "primary", url }, runtime);

    expect(refreshed.logContext.cacheStatus).toBe("bypass");
    expect(cached.logContext.cacheStatus).toBe("hit");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
  });

  it("never reads or writes the cache for recipe image scans", async () => {
    const { runtime, fallbackExtract } = createTestRuntime();
    const readSpy = vi.spyOn(runtime.extractionCache!, "read");
    const writeSpy = vi.spyOn(runtime.extractionCache!, "write");

    const result = await extractRecipe(
      {
        attempt: "fallback",
        images: [{ dataUrl: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" }],
        sourceUrl: "https://linkdish.app/image-imports/test"
      },
      runtime
    );

    expect(result.response.status).toBe("success");
    expect(result.logContext.cacheStatus).toBe("bypass");
    expect(fallbackExtract).toHaveBeenCalledTimes(1);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("hands post-response cache writes to the scheduler when one is provided", async () => {
    const { runtime } = createTestRuntime();
    const scheduled: Promise<unknown>[] = [];

    await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/recipe-jsonld" },
      runtime,
      {
        schedule: (task) => {
          scheduled.push(task);
        }
      }
    );

    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    await expect(
      runtime.extractionCache!.read("https://fixtures.linkdish.test/recipe-jsonld")
    ).resolves.not.toBeNull();
  });
});

describe("primary to fallback hand-off", () => {
  it("reuses the primary attempt's page for the fallback instead of fetching it again", async () => {
    const { runtime, fetchHtmlDocument, fallbackExtract } = createTestRuntime();
    const url = "https://fixtures.linkdish.test/article-weak";

    const primary = await extractRecipe({ attempt: "primary", url, correlationId }, runtime, {
      correlationId
    });
    const fallback = await extractRecipe({ attempt: "fallback", url, correlationId }, runtime, {
      correlationId
    });

    expect(primary.response.status).toBe("needs_retry");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(fallback.response).toMatchObject({
      status: "success",
      extraction: { strategy: "llm-fallback" },
      recipe: { title: "Fallback Skillet Dinner", sourceUrl: url }
    });
    expect(fallback.logContext.fallbackHandoff).toBe("used");

    const fallbackInput = fallbackExtract.mock.calls[0]?.[0];
    expect(fallbackInput?.sourceSummary).toContain("Page title:");
    expect(fallbackInput?.sourceDocument).toMatchObject({ kind: "html", html: "" });
    expect(fallbackInput?.candidate?.recipe.title).toBeTruthy();
    expect(fallbackInput?.deadline).toBeDefined();
  });

  it("fetches again when the fallback arrives under a different import", async () => {
    const { runtime, fetchHtmlDocument, fallbackExtract } = createTestRuntime();
    const url = "https://fixtures.linkdish.test/article-weak";

    await extractRecipe({ attempt: "primary", url }, runtime, { correlationId });
    const fallback = await extractRecipe({ attempt: "fallback", url }, runtime, {
      correlationId: "00000000-0000-4000-8000-000000000000"
    });

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(fallback.logContext.fallbackHandoff).toBe("missing");
    expect(fallbackExtract.mock.calls[0]?.[0].sourceSummary).toBeUndefined();
  });

  /*
   * Both adapters hand post-response work to a scheduler (waitUntil, fire-and-forget) that the
   * response does not wait for, and a client may send its fallback attempt right away.
   */
  const withHandoffWrite = (
    runtime: ExtractorRuntime,
    write: (
      store: FallbackHandoffStore,
      ...args: Parameters<FallbackHandoffStore["write"]>
    ) => Promise<boolean>
  ) => {
    const store = runtime.fallbackHandoffStore!;
    const writeSpy = vi.fn<FallbackHandoffStore["write"]>((...args) => write(store, ...args));
    runtime.fallbackHandoffStore = { read: (...args) => store.read(...args), write: writeSpy };
    return writeSpy;
  };

  const collectScheduled = () => {
    const scheduled: Promise<unknown>[] = [];
    return {
      scheduled,
      schedule: (task: Promise<unknown>) => {
        scheduled.push(task);
      }
    };
  };

  it("stores the hand-off before the primary answer resolves, for an immediate fallback", async () => {
    const { runtime, fetchHtmlDocument, fallbackExtract } = createTestRuntime();
    const write = withHandoffWrite(runtime, async (store, ...args) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return store.write(...args);
    });
    const { scheduled, schedule } = collectScheduled();
    const url = "https://fixtures.linkdish.test/article-weak";

    const primary = await extractRecipe({ attempt: "primary", url, correlationId }, runtime, {
      correlationId,
      schedule
    });
    /* Nothing scheduled is awaited: the fallback is sent the moment the primary answer lands. */
    const fallback = await extractRecipe({ attempt: "fallback", url, correlationId }, runtime, {
      correlationId,
      schedule
    });

    expect(primary.response.status).toBe("needs_retry");
    expect(write).toHaveBeenCalledTimes(1);
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(fallback.logContext.fallbackHandoff).toBe("used");
    expect(fallbackExtract.mock.calls[0]?.[0].sourceSummary).toContain("Page title:");
    await Promise.all(scheduled);
  });

  it("answers without waiting on a stalled hand-off write, which keeps running afterwards", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime } = createTestRuntime();
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    withHandoffWrite(runtime, async (store, ...args) => {
      await writeGate;
      return store.write(...args);
    });
    const { scheduled, schedule } = collectScheduled();
    const url = "https://fixtures.linkdish.test/article-weak";

    try {
      const primary = await extractRecipe({ attempt: "primary", url, correlationId }, runtime, {
        correlationId,
        schedule
      });

      expect(primary.response.status).toBe("needs_retry");
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: "extract_handoff_write_slow",
          waitedMs: FALLBACK_HANDOFF_MAX_WAIT_MS
        })
      );
      await expect(runtime.fallbackHandoffStore!.read(correlationId, url)).resolves.toBeNull();

      /* The write was handed to the scheduler, so it still lands after the response. */
      releaseWrite?.();
      await Promise.all(scheduled);
      await expect(runtime.fallbackHandoffStore!.read(correlationId, url)).resolves.toMatchObject({
        url
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("still answers needs_retry when the hand-off store fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime } = createTestRuntime();
    withHandoffWrite(runtime, () => Promise.reject(new Error("store unavailable")));
    const { scheduled, schedule } = collectScheduled();

    try {
      const primary = await extractRecipe(
        { attempt: "primary", url: "https://fixtures.linkdish.test/article-weak", correlationId },
        runtime,
        { correlationId, schedule }
      );

      expect(primary.response.status).toBe("needs_retry");
      await Promise.all(scheduled);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({ event: "extract_handoff_write_failed", message: "store unavailable" })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not wait for the hand-off while the fallback provider reads as off, but still stores it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runtime } = createTestRuntime({ fallbackAvailable: false });
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = withHandoffWrite(runtime, async (store, ...args) => {
      await writeGate;
      return store.write(...args);
    });
    const { scheduled, schedule } = collectScheduled();
    const url = "https://fixtures.linkdish.test/article-weak";

    try {
      const primary = await extractRecipe({ attempt: "primary", url, correlationId }, runtime, {
        correlationId,
        schedule
      });

      expect(primary.response.status).toBe("needs_retry");
      expect(write).toHaveBeenCalledTimes(1);
      /* No pre-response wait ran out, because none was started. */
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("extract_handoff_write_slow"));

      releaseWrite?.();
      await Promise.all(scheduled);
      await expect(runtime.fallbackHandoffStore!.read(correlationId, url)).resolves.toMatchObject({
        url
      });
    } finally {
      warn.mockRestore();
    }
  });

  /*
   * Each instance caches the admin provider switch for up to 30 s (and keeps the env default
   * after a failed load), while the needs_retry answer always offers the fallback. A primary
   * instance that still reads the provider as off must leave a hand-off for a fallback attempt
   * that lands on an instance which already reads it as on.
   */
  it("leaves a hand-off for a fallback served by an instance with fresher provider settings", async () => {
    const primaryInstance = createTestRuntime({ fallbackAvailable: false });
    const fallbackInstance = createTestRuntime();
    fallbackInstance.runtime.fallbackHandoffStore = primaryInstance.runtime.fallbackHandoffStore!;
    const { scheduled, schedule } = collectScheduled();
    const url = "https://fixtures.linkdish.test/article-weak";

    const primary = await extractRecipe(
      { attempt: "primary", url, correlationId },
      primaryInstance.runtime,
      { correlationId, schedule }
    );
    await Promise.all(scheduled);
    const fallback = await extractRecipe(
      { attempt: "fallback", url, correlationId },
      fallbackInstance.runtime,
      { correlationId, schedule }
    );
    await Promise.all(scheduled);

    expect(primary.response.status).toBe("needs_retry");
    expect(fallback.response.status).toBe("success");
    expect(fallback.logContext.fallbackHandoff).toBe("used");
    expect(primaryInstance.fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(fallbackInstance.fetchHtmlDocument).not.toHaveBeenCalled();
  });

  it("keeps cache writes after the response", async () => {
    const { runtime } = createTestRuntime();
    let releaseWrite: (() => void) | undefined;
    const cacheWrite = runtime.extractionCache!.write.bind(runtime.extractionCache);
    runtime.extractionCache = {
      ...runtime.extractionCache!,
      write: async (entry) => {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        return cacheWrite(entry);
      }
    };
    const { scheduled, schedule } = collectScheduled();

    const result = await extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/recipe-jsonld", correlationId },
      runtime,
      { correlationId, schedule }
    );

    expect(result.response.status).toBe("success");
    expect(scheduled).toHaveLength(1);
    releaseWrite?.();
    await Promise.all(scheduled);
  });
});

describe("billing gate and cancellation", () => {
  it("cancels the extraction after the speculative fetch when billing denies it", async () => {
    const clean = vi.fn<RecipeTextCleaner["clean"]>((recipe) => Promise.resolve(recipe));
    const { runtime, fetchHtmlDocument, fallbackExtract } = createTestRuntime({
      cleaner: { available: true, providerName: "gemini", clean }
    });
    const writeSpy = vi.spyOn(runtime.extractionCache!, "write");

    await expect(
      extractRecipe(
        { attempt: "fallback", url: "https://fixtures.linkdish.test/article-weak" },
        runtime,
        { authorization: Promise.resolve(false) }
      )
    ).rejects.toBeInstanceOf(ExtractionCancelledError);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(fallbackExtract).not.toHaveBeenCalled();
    expect(clean).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("aborts in-flight fetches through the request deadline when the caller cancels", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime();
    const cancellation = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    fetchHtmlDocument.mockImplementationOnce((_url, options) => {
      fetchSignal = options?.deadline?.signal;
      return new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const extraction = extractRecipe(
      { attempt: "primary", url: "https://fixtures.linkdish.test/recipe-jsonld" },
      runtime,
      { signal: cancellation.signal }
    );
    await vi.waitFor(() => {
      expect(fetchSignal).toBeDefined();
    });
    cancellation.abort();

    await expect(extraction).resolves.toMatchObject({
      response: { status: "failure" }
    });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("answers fallback_unavailable without fetching when no provider is configured", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime({ fallbackAvailable: false });

    const result = await extractRecipe(
      { attempt: "fallback", url: "https://fixtures.linkdish.test/article-weak" },
      runtime
    );

    expect(result.response).toMatchObject({ status: "failure", reason: "fallback_unavailable" });
    expect(fetchHtmlDocument).not.toHaveBeenCalled();
  });

  it("refreshes the admin-managed provider settings before checking fallback availability", async () => {
    const extractor = {
      available: false,
      providerName: "none" as "gemini" | "none",
      extract: vi.fn<FallbackRecipeExtractor["extract"]>(() => Promise.resolve(fallbackCandidate)),
      refresh: vi.fn(() => {
        extractor.available = true;
        extractor.providerName = "gemini";
        return Promise.resolve();
      })
    };
    const { runtime } = createTestRuntime();
    runtime.fallbackExtractor = extractor;

    const result = await extractRecipe(
      { attempt: "fallback", url: "https://fixtures.linkdish.test/article-weak" },
      runtime
    );

    expect(extractor.refresh).toHaveBeenCalled();
    expect(result.response.status).toBe("success");
    expect(result.logContext.fallbackProvider).toBe("gemini");
  });
});
