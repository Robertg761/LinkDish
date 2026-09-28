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

import { getAdminMetricsSnapshot } from "../../admin/metrics";
import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";

import { runExtractRequestPipeline } from "./extract-request-pipeline";

import type { ExtractorRuntime } from "../types";

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

const createRuntime = () => {
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
    fallbackExtractor: {
      available: false,
      providerName: "none",
      extract: () => Promise.resolve(null)
    },
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
  schedule: (task: Promise<unknown>) => void = () => undefined
) =>
  runExtractRequestPipeline({
    payload: {
      attempt: "primary",
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
    },
    headers: { "x-linkdish-client-id": "client-1" },
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
});
