import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeExtractionRequest: vi.fn(),
  recordDurableExtractionAnalyticsEvent: vi.fn()
}));

vi.mock("../../billing/enforce-billing.js", () => ({
  authorizeExtractionRequest: mocks.authorizeExtractionRequest
}));

vi.mock("../../analytics/extraction-analytics.js", () => ({
  recordDurableExtractionAnalyticsEvent: mocks.recordDurableExtractionAnalyticsEvent
}));

import { extractorApiEnv } from "../../../config/env";
import { getAdminMetricsSnapshot } from "../../admin/metrics";
import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";

import { runExtractRequestPipeline } from "./extract-request-pipeline";

import type { ExtractRecipeAnyRequest } from "../../../../../../packages/api-contracts/src/index.js";
import type { ExtractionCandidate, ExtractorRuntime, FallbackRecipeExtractor } from "../types";

const recipeJsonLd = readFileSync(
  new URL("../__fixtures__/recipe-jsonld.html", import.meta.url),
  "utf8"
);

const billingLogContext = {
  accountUserId: null,
  billingClientId: "client-1",
  billingEnabled: true,
  billingQuotaIdentity: "network",
  billingPlan: "free",
  householdId: null,
  householdRole: null,
  meteringMode: "free_lifetime",
  quotaCount: 0,
  quotaKind: "imports",
  quotaLimit: 3
};

/* What an LLM re-extraction of the page could produce, e.g. steered by text in its comments. */
const llmCandidate: ExtractionCandidate = {
  recipe: {
    title: "LLM Output Title",
    ingredients: [{ text: "12 oz spaghetti" }, { text: "2 cups cherry tomatoes" }],
    steps: [
      { index: 1, text: "Boil the pasta." },
      { index: 2, text: "Toss with the tomatoes." }
    ],
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
    detectionConfidence: "high",
    sectionCohesion: "strong",
    transcriptQuality: "weak",
    usedBrowserFallback: false,
    blockedSourceSignals: 0
  }
};

const createRuntime = (
  fallbackExtractor: FallbackRecipeExtractor = {
    available: false,
    providerName: "none",
    extract: () => Promise.resolve(null)
  }
) => {
  const fetchHtmlDocument = vi.fn<ExtractorRuntime["fetchHtmlDocument"]>((url: string) =>
    Promise.resolve({
      document: {
        kind: "html" as const,
        url,
        finalUrl: url,
        html: recipeJsonLd,
        contentType: "text/html",
        title: "One-Pan Tomato Pasta",
        description: null,
        blockedSignals: [],
        statusCode: 200
      },
      mode: "http" as const,
      blockedSignals: []
    })
  );
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument,
    fetchYouTubeDocument: () => Promise.reject(new Error("unused")),
    fallbackExtractor,
    extractionCache: createExtractionResultCache({
      ttlSeconds: 600,
      store: createMemoryCacheStore(10)
    }),
    validateSourceUrl: () => Promise.resolve({ safe: true }),
    dispose: () => Promise.resolve()
  };

  return { runtime, fetchHtmlDocument };
};

const logger = { info: vi.fn(), warn: vi.fn() };

const runPipeline = (
  runtime: ExtractorRuntime,
  schedule: (task: Promise<unknown>) => void = () => undefined,
  request: { payload?: ExtractRecipeAnyRequest; headers?: Record<string, string> } = {}
) =>
  runExtractRequestPipeline({
    payload: request.payload ?? {
      attempt: "primary",
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
    },
    headers: request.headers ?? { "x-linkdish-client-id": "client-1" },
    identity: { remoteAddress: "198.51.100.7" },
    startedAt: Date.now(),
    runtime,
    schedule,
    logger
  });

beforeEach(() => {
  mocks.recordDurableExtractionAnalyticsEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runExtractRequestPipeline", () => {
  it("still authorizes and commits usage for a cache hit", async () => {
    const commitUsage = vi.fn((response: { status: string }) =>
      Promise.resolve({ ...billingLogContext, quotaCount: response.status === "success" ? 1 : 0 })
    );
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage,
      logContext: billingLogContext
    });
    const { runtime, fetchHtmlDocument } = createRuntime();

    const first = await runPipeline(runtime);
    const second = await runPipeline(runtime);

    expect(fetchHtmlDocument).toHaveBeenCalledTimes(1);
    expect(first.headers).toEqual({ "x-linkdish-cache": "miss" });
    expect(second.headers).toEqual({ "x-linkdish-cache": "hit" });
    expect(second.response.status).toBe("success");
    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledTimes(2);
    expect(commitUsage).toHaveBeenCalledTimes(2);
    expect(commitUsage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "success" }));
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ cacheStatus: "hit", outcomeStatus: "success" })
    );
  });

  it("aborts the speculative fetch when billing denies the request", async () => {
    let fetchSignal: AbortSignal | undefined;
    let resolveBilling: ((value: unknown) => void) | undefined;
    mocks.authorizeExtractionRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveBilling = resolve;
      })
    );
    const { runtime, fetchHtmlDocument } = createRuntime();
    fetchHtmlDocument.mockImplementationOnce((_url, options) => {
      fetchSignal = options?.deadline?.signal;
      return new Promise((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const resultPromise = runPipeline(runtime);
    await vi.waitFor(() => {
      expect(fetchSignal).toBeDefined();
    });
    expect(fetchSignal?.aborted).toBe(false);

    resolveBilling?.({
      allowed: false,
      commitUsage: vi.fn(),
      logContext: billingLogContext,
      response: {
        status: "failure",
        reason: "plan_limit",
        userMessage: "You have used your free recipe allowance.",
        recovery: { retryable: true, allowFallback: false, suggestedAction: "try_again_later" }
      }
    });

    await expect(resultPromise).resolves.toMatchObject({
      response: { status: "failure", reason: "plan_limit" }
    });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("runs durable analytics after the response and records admin metrics", async () => {
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: () => Promise.resolve(billingLogContext),
      logContext: billingLogContext
    });
    mocks.recordDurableExtractionAnalyticsEvent.mockReturnValue(new Promise(() => undefined));
    const scheduled: Promise<unknown>[] = [];
    const before = getAdminMetricsSnapshot().totalRequests;
    const { runtime } = createRuntime();

    const result = await runPipeline(runtime, (task) => {
      scheduled.push(task);
    });

    expect(result.response.status).toBe("success");
    expect(mocks.recordDurableExtractionAnalyticsEvent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ latencyMs: expect.any(Number) as number }),
      { correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb" }
    );
    /* One cache write plus the (still pending) analytics write. */
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    expect(getAdminMetricsSnapshot().totalRequests).toBe(before + 1);
  });

  describe("live canary and the shared result cache", () => {
    const url = "https://fixtures.linkdish.test/recipe-jsonld";
    const originalCanaryToken = extractorApiEnv.LINKDISH_CANARY_TOKEN;

    beforeEach(() => {
      extractorApiEnv.LINKDISH_CANARY_TOKEN = "canary-secret-token";
      mocks.authorizeExtractionRequest.mockResolvedValue({
        allowed: true,
        commitUsage: () => Promise.resolve(billingLogContext),
        logContext: billingLogContext
      });
    });

    afterEach(() => {
      extractorApiEnv.LINKDISH_CANARY_TOKEN = originalCanaryToken;
    });

    const runAndSettle = async (
      runtime: ExtractorRuntime,
      payload: ExtractRecipeAnyRequest,
      headers: Record<string, string>
    ) => {
      const scheduled: Promise<unknown>[] = [];
      const result = await runPipeline(runtime, (task) => scheduled.push(task), {
        payload,
        headers
      });
      await Promise.all(scheduled);
      return result;
    };

    it("does not let a canary header without the canary token overwrite a cached recipe", async () => {
      const extract = vi.fn<FallbackRecipeExtractor["extract"]>(() =>
        Promise.resolve(llmCandidate)
      );
      const { runtime } = createRuntime({ available: true, providerName: "gemini", extract });

      const first = await runAndSettle(
        runtime,
        { attempt: "primary", url },
        { "x-linkdish-client-id": "victim-1" }
      );
      await runAndSettle(
        runtime,
        { attempt: "fallback", url },
        { "x-linkdish-client-id": "attacker", "x-linkdish-canary": "1" }
      );
      const next = await runAndSettle(
        runtime,
        { attempt: "primary", url },
        { "x-linkdish-client-id": "victim-2" }
      );

      expect(first.response).toMatchObject({
        status: "success",
        recipe: { title: "One-Pan Tomato Pasta" }
      });
      expect(next.headers).toEqual({ "x-linkdish-cache": "hit" });
      expect(next.response).toMatchObject({
        status: "success",
        recipe: { title: "One-Pan Tomato Pasta" },
        extraction: { strategy: "recipe-schema" }
      });
    });

    it("lets the verified canary read around the cache and refresh it", async () => {
      const { runtime, fetchHtmlDocument } = createRuntime();

      await runAndSettle(runtime, { attempt: "primary", url }, { "x-linkdish-client-id": "a" });
      const canary = await runAndSettle(
        runtime,
        { attempt: "primary", url },
        {
          authorization: "Bearer canary-secret-token",
          "x-linkdish-canary": "1",
          "x-linkdish-client-id": "live-canary"
        }
      );
      const forged = await runAndSettle(
        runtime,
        { attempt: "primary", url },
        {
          authorization: "Bearer wrong-token",
          "x-linkdish-canary": "1",
          "x-linkdish-client-id": "live-canary"
        }
      );

      expect(canary.headers).toEqual({ "x-linkdish-cache": "bypass" });
      expect(forged.headers).toEqual({ "x-linkdish-cache": "hit" });
      expect(fetchHtmlDocument).toHaveBeenCalledTimes(2);
    });

    it("never stores LLM fallback output, even for the verified canary", async () => {
      const extract = vi.fn<FallbackRecipeExtractor["extract"]>(() =>
        Promise.resolve(llmCandidate)
      );
      const { runtime, fetchHtmlDocument } = createRuntime({
        available: true,
        providerName: "gemini",
        extract
      });

      const seeded = await runAndSettle(
        runtime,
        { attempt: "fallback", url },
        { "x-linkdish-client-id": "attacker" }
      );
      await runAndSettle(
        runtime,
        { attempt: "fallback", url },
        { authorization: "Bearer canary-secret-token", "x-linkdish-canary": "1" }
      );
      const next = await runAndSettle(
        runtime,
        { attempt: "primary", url },
        { "x-linkdish-client-id": "victim" }
      );

      expect(seeded.response).toMatchObject({
        status: "success",
        recipe: { title: "LLM Output Title" },
        extraction: { strategy: "llm-fallback" }
      });
      expect(next.headers).toEqual({ "x-linkdish-cache": "miss" });
      expect(next.response).toMatchObject({
        status: "success",
        recipe: { title: "One-Pan Tomato Pasta" },
        extraction: { strategy: "recipe-schema" }
      });
      expect(fetchHtmlDocument).toHaveBeenCalledTimes(3);
    });
  });
});
