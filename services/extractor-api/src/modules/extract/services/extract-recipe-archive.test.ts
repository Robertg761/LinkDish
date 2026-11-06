import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore } from "../cache/cache-store";
import { hashCanonicalSourceUrl } from "../cache/canonical-url";
import { createExtractionResultCache } from "../cache/extraction-cache";
import {
  createMemoryRecipeArchiveStore,
  createRecipeArchive,
  type RecipeArchiveStore
} from "../cache/recipe-archive";
import { HtmlFetchError } from "../fetchers/errors";

import { extractRecipe } from "./extract-recipe";

import type { ExtractorRuntime } from "../types";

const recipeJsonLd = readFileSync(
  new URL("../__fixtures__/recipe-jsonld.html", import.meta.url),
  "utf8"
);

const recipeUrl = "https://fixtures.linkdish.test/recipe-jsonld";
const dayMs = 86_400_000;

const createTestRuntime = (
  options: {
    archiveStore?: RecipeArchiveStore;
    blocked?: () => boolean;
    refreshAfterMs?: number;
  } = {}
) => {
  const archiveStore = options.archiveStore ?? createMemoryRecipeArchiveStore();
  const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>((url: string) => {
    if (options.blocked?.()) {
      return Promise.reject(new HtmlFetchError("Blocked", "blocked", ["status_402"], 402, url));
    }

    return Promise.resolve({
      document: {
        kind: "html" as const,
        url,
        finalUrl: url,
        html: recipeJsonLd,
        contentType: "text/html",
        title: "Fixture HTML",
        description: null,
        blockedSignals: [],
        statusCode: 200
      },
      mode: "http" as const,
      blockedSignals: []
    });
  });
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument,
    fetchYouTubeDocument: () => Promise.reject(new Error("YouTube is not used here.")),
    fallbackExtractor: {
      available: false,
      providerName: "none",
      extract: () => Promise.reject(new Error("No fallback here."))
    },
    extractionCache: createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(50)
    }),
    recipeArchive: createRecipeArchive({
      store: archiveStore,
      refreshAfterMs: options.refreshAfterMs ?? 30 * dayMs
    }),
    validateSourceUrl: vi.fn(() => Promise.resolve({ safe: true as const })),
    dispose: () => Promise.resolve()
  };

  /* A new process: the short-lived cache is empty, the archive database is not. */
  const withEmptyCache = (): ExtractorRuntime => ({
    ...runtime,
    extractionCache: createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(50)
    })
  });

  return { runtime, withEmptyCache, fetchHtmlDocument, archiveStore };
};

const ageArchiveEntry = (
  store: ReturnType<typeof createMemoryRecipeArchiveStore>,
  url: string,
  changes: { extractedAt?: string; extractorVersion?: string }
) => {
  const key = hashCanonicalSourceUrl(url);
  const record = store.records.get(key);

  if (!record) {
    throw new Error("No archive entry to age.");
  }

  store.records.set(key, { ...record, ...changes });
};

describe("recipe archive in the extract pipeline", () => {
  it("keeps a successful import and serves the next one from the archive without fetching", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    const first = await extractRecipe(
      { attempt: "primary", url: `${recipeUrl}?utm_source=pin` },
      runtime
    );

    expect(first.response.status).toBe("success");
    expect(archiveStore.records.size).toBe(1);
    const [record] = archiveStore.records.values();
    expect(record).toMatchObject({
      canonicalUrl: recipeUrl,
      sourceHostname: "fixtures.linkdish.test",
      origin: "server",
      refreshFailedAt: null
    });
    /* Structured recipe only: no page HTML is kept, nor the first importer's exact link. */
    expect(JSON.stringify(record?.response)).not.toContain("<html");
    expect(JSON.stringify(record?.response)).not.toContain("utm_source");

    const freshProcess = withEmptyCache();
    const second = await extractRecipe(
      { attempt: "primary", url: `${recipeUrl}/?fbclid=abc` },
      freshProcess
    );

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(second.logContext).toMatchObject({
      cacheStatus: "archive",
      browserAttempted: false,
      outcomeStatus: "success"
    });
    expect(second.response).toEqual({
      ...first.response,
      recipe: {
        ...(first.response.status === "success" ? first.response.recipe : {}),
        sourceUrl: `${recipeUrl}/?fbclid=abc`
      }
    });

    /* The archive hit refilled the short-lived cache. */
    const third = await extractRecipe({ attempt: "primary", url: recipeUrl }, freshProcess);
    expect(third.logContext.cacheStatus).toBe("hit");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
  });

  it("serves from the archive when the result cache is switched off", async () => {
    const { runtime, fetchHtmlDocument } = createTestRuntime();
    const withoutCache: ExtractorRuntime = { ...runtime };
    delete withoutCache.extractionCache;

    await extractRecipe({ attempt: "primary", url: recipeUrl }, withoutCache);
    const second = await extractRecipe({ attempt: "primary", url: recipeUrl }, withoutCache);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(second.logContext.cacheStatus).toBe("archive");
  });

  it("reads the site again once the entry is past the refresh age and replaces it", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    const oldDate = new Date(Date.now() - 31 * dayMs).toISOString();
    ageArchiveEntry(archiveStore, recipeUrl, { extractedAt: oldDate });

    const refreshed = await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache());

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(refreshed.logContext.cacheStatus).toBe("miss");
    expect(archiveStore.records.get(hashCanonicalSourceUrl(recipeUrl))?.extractedAt).not.toBe(
      oldDate
    );
  });

  it("reads the site again for an entry from an older extractor version", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    ageArchiveEntry(archiveStore, recipeUrl, { extractorVersion: "2000-01-01.1" });

    const refreshed = await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache());

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(refreshed.logContext.cacheStatus).toBe("miss");
  });

  it("serves the archived copy when the site now blocks LinkDish, then waits a day before asking again", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    let blocked = false;
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({
      archiveStore,
      blocked: () => blocked
    });

    const first = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    ageArchiveEntry(archiveStore, recipeUrl, {
      extractedAt: new Date(Date.now() - 45 * dayMs).toISOString()
    });
    blocked = true;

    const stale = await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache());

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(stale.logContext).toMatchObject({
      cacheStatus: "archive_stale",
      outcomeStatus: "success"
    });
    expect(stale.response).toEqual(first.response);
    expect(stale.response.status === "success" && stale.response.recipe.sourceUrl).toBe(recipeUrl);
    expect(archiveStore.records.get(hashCanonicalSourceUrl(recipeUrl))?.refreshFailedAt).toEqual(
      expect.any(String)
    );

    const sameProcess = withEmptyCache();
    const backedOff = await extractRecipe({ attempt: "primary", url: recipeUrl }, sameProcess);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(backedOff.logContext.cacheStatus).toBe("archive");

    /* The backed-off copy was not put in the result cache, so the next try reaches the archive. */
    const again = await extractRecipe({ attempt: "primary", url: recipeUrl }, sameProcess);
    expect(again.logContext.cacheStatus).toBe("archive");
  });

  it("returns the site's failure when there is no archived copy", async () => {
    const { runtime } = createTestRuntime({ blocked: () => true });

    const result = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);

    expect(result.response.status).toBe("failure");
    expect(result.logContext.cacheStatus).toBe("miss");
  });

  it("ignores an archived entry holding LLM output", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    const key = hashCanonicalSourceUrl(recipeUrl);
    const record = archiveStore.records.get(key);
    const response = record?.response as { extraction: Record<string, unknown> };
    archiveStore.records.set(key, {
      ...record!,
      response: { ...response, extraction: { ...response.extraction, strategy: "llm-fallback" } }
    });

    const result = await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache());

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(result.logContext.cacheStatus).toBe("miss");
  });

  it("treats a slow or failing archive as a miss", async () => {
    const hanging: RecipeArchiveStore = {
      get: () => new Promise(() => undefined),
      put: () => Promise.resolve(true),
      markRefreshFailed: () => Promise.resolve(),
      remove: () => Promise.resolve(false)
    };
    const failing: RecipeArchiveStore = {
      ...hanging,
      get: () => Promise.reject(new Error("database down")),
      put: () => Promise.reject(new Error("database down"))
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const slow = createTestRuntime({ archiveStore: hanging });
      const pending = extractRecipe({ attempt: "primary", url: recipeUrl }, slow.runtime);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).response.status).toBe("success");
    } finally {
      vi.useRealTimers();
    }

    const broken = createTestRuntime({ archiveStore: failing });
    const result = await extractRecipe({ attempt: "primary", url: recipeUrl }, broken.runtime);
    expect(result.response.status).toBe("success");
    expect(result.logContext.cacheStatus).toBe("miss");

    /* The result cache is still written when the archive write fails. */
    const again = await extractRecipe({ attempt: "primary", url: recipeUrl }, broken.runtime);
    expect(again.logContext.cacheStatus).toBe("hit");
  });

  it("keeps a removed link out of the archive and the result cache", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    await expect(runtime.recipeArchive?.remove(`${recipeUrl}?utm_source=x`)).resolves.toBe(true);
    await runtime.extractionCache?.remove(recipeUrl);
    expect(archiveStore.records.size).toBe(0);

    const afterRemoval = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    const nextImport = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);

    expect(afterRemoval.response.status).toBe("success");
    expect(nextImport.logContext.cacheStatus).toBe("miss");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(3);
    expect(archiveStore.records.size).toBe(0);
  });

  it("never serves a row that a write raced in while the link was being removed", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    const key = hashCanonicalSourceUrl(recipeUrl);
    const raced = archiveStore.records.get(key);
    await runtime.recipeArchive?.remove(recipeUrl);
    archiveStore.records.set(key, raced!);

    const result = await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache());

    expect(result.logContext.cacheStatus).toBe("miss");
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
  });

  it("does not start the refresh backoff when billing turned the request down", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, withEmptyCache } = createTestRuntime({
      archiveStore,
      blocked: () => blockedNow
    });
    let blockedNow = false;

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    ageArchiveEntry(archiveStore, recipeUrl, {
      extractedAt: new Date(Date.now() - 45 * dayMs).toISOString()
    });
    blockedNow = true;

    await extractRecipe({ attempt: "primary", url: recipeUrl }, withEmptyCache(), {
      authorization: Promise.resolve(false)
    }).catch(() => undefined);

    expect(archiveStore.records.get(hashCanonicalSourceUrl(recipeUrl))?.refreshFailedAt).toBeNull();
  });

  it("neither reads nor writes the archive when the cache is bypassed", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime } = createTestRuntime({ archiveStore });

    const result = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime, {
      cacheMode: "bypass"
    });

    expect(result.response.status).toBe("success");
    expect(archiveStore.records.size).toBe(0);
  });

  it("lets the canary skip the archive read but refresh the entry", async () => {
    const archiveStore = createMemoryRecipeArchiveStore();
    const { runtime, fetchHtmlDocument } = createTestRuntime({ archiveStore });

    await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime);
    const oldDate = new Date(Date.now() - dayMs).toISOString();
    ageArchiveEntry(archiveStore, recipeUrl, { extractedAt: oldDate });

    const canary = await extractRecipe({ attempt: "primary", url: recipeUrl }, runtime, {
      cacheMode: "refresh"
    });

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    expect(canary.logContext.cacheStatus).toBe("bypass");
    expect(archiveStore.records.get(hashCanonicalSourceUrl(recipeUrl))?.extractedAt).not.toBe(
      oldDate
    );
  });
});
