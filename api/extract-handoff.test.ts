import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryCacheStore } from "../services/extractor-api/src/modules/extract/cache/cache-store.js";
import { createFallbackHandoffStore } from "../services/extractor-api/src/modules/extract/cache/fallback-handoff.js";

import type { FallbackHandoffStore } from "../services/extractor-api/src/modules/extract/cache/fallback-handoff.js";
import type {
  ExtractionCandidate,
  ExtractorRuntime,
  FallbackRecipeExtractor
} from "../services/extractor-api/src/modules/extract/types.js";

/*
 * The Vercel adapter end to end (rate limit, billing and analytics stubbed): the real
 * pipeline and extraction run against a test runtime, and waitUntil only collects tasks, as
 * the platform keeps them alive after the response without the response waiting for them.
 */
const mocks = vi.hoisted(() => ({
  authorizeExtractionRequest: vi.fn(),
  checkExtractRateLimit: vi.fn(),
  getSharedExtractorRuntime: vi.fn(),
  recordDurableExtractionAnalyticsEvent: vi.fn(),
  waitUntil: vi.fn()
}));

vi.mock("@vercel/functions", () => ({
  ipAddress: () => undefined,
  waitUntil: mocks.waitUntil
}));

vi.mock("../services/extractor-api/src/modules/billing/enforce-billing.js", () => ({
  authorizeExtractionRequest: mocks.authorizeExtractionRequest
}));

vi.mock("../services/extractor-api/src/modules/analytics/extraction-analytics.js", () => ({
  recordDurableExtractionAnalyticsEvent: mocks.recordDurableExtractionAnalyticsEvent
}));

vi.mock("../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js", () => ({
  checkExtractRateLimit: mocks.checkExtractRateLimit,
  RateLimitUnavailableError: class RateLimitUnavailableError extends Error {}
}));

vi.mock(
  "../services/extractor-api/src/modules/extract/services/runtime.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getSharedExtractorRuntime: mocks.getSharedExtractorRuntime
  })
);

const articleWeak = readFileSync(
  new URL(
    "../services/extractor-api/src/modules/extract/__fixtures__/article-weak.html",
    import.meta.url
  ),
  "utf8"
);

const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";
const url = "https://fixtures.linkdish.test/article-weak";

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

const createRuntime = (
  write: (
    store: FallbackHandoffStore,
    ...args: Parameters<FallbackHandoffStore["write"]>
  ) => Promise<boolean>
) => {
  const store = createFallbackHandoffStore({ store: createMemoryCacheStore(10) });
  const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>((pageUrl: string) =>
    Promise.resolve({
      document: {
        kind: "html" as const,
        url: pageUrl,
        finalUrl: pageUrl,
        html: articleWeak,
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
  const extract = vi.fn<FallbackRecipeExtractor["extract"]>(() =>
    Promise.resolve(fallbackCandidate)
  );
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument,
    fetchYouTubeDocument: () => Promise.reject(new Error("YouTube is not used here.")),
    fallbackExtractor: { available: true, providerName: "gemini", extract },
    fallbackHandoffStore: {
      read: (...args) => store.read(...args),
      write: (...args) => write(store, ...args)
    },
    validateSourceUrl: () => Promise.resolve({ safe: true as const }),
    dispose: () => Promise.resolve()
  };

  mocks.getSharedExtractorRuntime.mockReturnValue(runtime);
  return { runtime, store, fetchHtmlDocument, extract };
};

const postExtract = async (attempt: "primary" | "fallback") => {
  const extractApi = await import("./extract.js");

  return extractApi.POST(
    new Request("https://api.linkdish.ca/extract", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linkdish-client-id": "paid-user"
      },
      body: JSON.stringify({ attempt, url, correlationId })
    })
  );
};

const scheduledTasks = () => mocks.waitUntil.mock.calls.map(([task]) => task as Promise<unknown>);

describe("Vercel extract adapter primary-to-fallback hand-off", () => {
  beforeEach(() => {
    mocks.checkExtractRateLimit.mockResolvedValue({
      allowed: true,
      headers: {},
      logContext: {},
      retryAfterSeconds: 60
    });
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn().mockResolvedValue({ billingClientId: "paid-user" }),
      logContext: { billingClientId: "paid-user" }
    });
    mocks.recordDurableExtractionAnalyticsEvent.mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await Promise.allSettled(scheduledTasks());
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("stores the hand-off before answering, so an immediate fallback skips the second fetch", async () => {
    const { fetchHtmlDocument, extract } = createRuntime(async (store, ...args) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return store.write(...args);
    });

    const primary = await postExtract("primary");
    /* Nothing handed to waitUntil has been awaited: the client retries the moment it can. */
    const fallback = await postExtract("fallback");

    expect(primary.status).toBe(200);
    await expect(primary.json()).resolves.toMatchObject({ status: "needs_retry" });
    expect(fallback.status).toBe(200);
    await expect(fallback.json()).resolves.toMatchObject({
      status: "success",
      extraction: { strategy: "llm-fallback" }
    });
    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[0].sourceSummary).toContain("Page title:");
  });

  it("answers a stalled hand-off write in time and leaves it to waitUntil", async () => {
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { store } = createRuntime(async (handoffStore, ...args) => {
      await writeGate;
      return handoffStore.write(...args);
    });

    const primary = await postExtract("primary");

    expect(primary.status).toBe(200);
    await expect(primary.json()).resolves.toMatchObject({ status: "needs_retry" });
    await expect(store.read(correlationId, url)).resolves.toBeNull();

    releaseWrite?.();
    await Promise.all(scheduledTasks());
    await expect(store.read(correlationId, url)).resolves.toMatchObject({ url });
  });

  it("still answers needs_retry with a 200 when the hand-off store fails", async () => {
    createRuntime(() => Promise.reject(new Error("store unavailable")));

    const primary = await postExtract("primary");

    expect(primary.status).toBe(200);
    await expect(primary.json()).resolves.toMatchObject({ status: "needs_retry" });
  });
});
