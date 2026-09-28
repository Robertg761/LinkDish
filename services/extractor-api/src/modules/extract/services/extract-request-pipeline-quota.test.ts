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

import { createMemoryCacheStore } from "../cache/cache-store";
import { createExtractionResultCache } from "../cache/extraction-cache";

import { runExtractRequestPipeline } from "./extract-request-pipeline";

import type { ExtractRecipeAnyRequest } from "../../../../../../packages/api-contracts/src/index.js";
import type { ExtractionCandidate, ExtractorRuntime } from "../types";

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

const quota = {
  limit: 3,
  remaining: 1,
  monthlyLimit: null,
  remainingThisMonth: null,
  resetsAt: null,
  meteringMode: "free_lifetime" as const
};

const llmCandidate: ExtractionCandidate = {
  recipe: {
    title: "Pasted Lentil Soup",
    ingredients: [{ text: "1 cup red lentils" }, { text: "4 cups stock" }],
    steps: [{ index: 1, text: "Simmer the lentils in the stock for 25 minutes." }],
    servings: "4 servings",
    prepTimeMinutes: 5,
    cookTimeMinutes: 25,
    nutrition: null
  },
  strategy: "llm-fallback",
  evidence: ["The pasted text contained a complete recipe."],
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
};

const createRuntime = () => {
  const cache = createExtractionResultCache({
    ttlSeconds: 600,
    store: createMemoryCacheStore(10)
  });
  const runtime: ExtractorRuntime = {
    fetchImplementation: fetch,
    fetchHtmlDocument: (url: string) =>
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
      }),
    fetchYouTubeDocument: () => Promise.reject(new Error("unused")),
    fallbackExtractor: {
      available: true,
      providerName: "gemini",
      extract: () => Promise.resolve(llmCandidate)
    },
    extractionCache: cache,
    validateSourceUrl: () => Promise.resolve({ safe: true }),
    dispose: () => Promise.resolve()
  };

  return { runtime, cache };
};

const logger = { info: vi.fn(), warn: vi.fn() };

const runPipeline = (runtime: ExtractorRuntime, payload: ExtractRecipeAnyRequest) =>
  runExtractRequestPipeline({
    payload,
    headers: { "x-linkdish-client-id": "client-1" },
    identity: { remoteAddress: "198.51.100.7" },
    startedAt: Date.now(),
    runtime,
    schedule: () => undefined,
    logger
  });

const recipeText = [
  "Weeknight lentil soup",
  "Ingredients: 1 cup red lentils, 4 cups stock, 1 onion",
  "Simmer everything for 25 minutes and season with salt."
].join("\n");

beforeEach(() => {
  mocks.recordDurableExtractionAnalyticsEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("quota on success responses", () => {
  it("attaches the committed allowance to a success", async () => {
    const commitUsageWithQuota = vi.fn(() =>
      Promise.resolve({ logContext: { ...billingLogContext, quotaCount: 2 }, quota })
    );
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn(),
      commitUsageWithQuota,
      logContext: billingLogContext
    });
    const { runtime } = createRuntime();

    const result = await runPipeline(runtime, {
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      attempt: "primary"
    });

    expect(result.response).toMatchObject({ status: "success", quota });
    expect(commitUsageWithQuota).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenLastCalledWith(expect.objectContaining({ quotaCount: 2 }));
  });

  it("never stores the caller's quota in the shared result cache", async () => {
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn(),
      commitUsageWithQuota: () => Promise.resolve({ logContext: billingLogContext, quota }),
      logContext: billingLogContext
    });
    const { runtime, cache } = createRuntime();

    await runPipeline(runtime, {
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      attempt: "primary"
    });
    const cached = await cache.read("https://fixtures.linkdish.test/recipe-jsonld");

    expect(cached?.response.status).toBe("success");
    expect(cached?.response).not.toHaveProperty("quota");
  });

  it("falls back to commitUsage (and no quota) for authorizations without the new method", async () => {
    const commitUsage = vi.fn(() => Promise.resolve(billingLogContext));
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage,
      logContext: billingLogContext
    });
    const { runtime } = createRuntime();

    const result = await runPipeline(runtime, {
      url: "https://fixtures.linkdish.test/recipe-jsonld",
      attempt: "primary"
    });

    expect(commitUsage).toHaveBeenCalledTimes(1);
    expect(result.response).not.toHaveProperty("quota");
  });
});

describe("text import billing", () => {
  it("meters pasted text like an explicit fallback attempt", async () => {
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn(),
      commitUsageWithQuota: () => Promise.resolve({ logContext: billingLogContext, quota }),
      logContext: billingLogContext
    });
    const { runtime } = createRuntime();

    const result = await runPipeline(runtime, { text: recipeText, attempt: "primary" });

    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledWith(
      expect.any(Object),
      "fallback",
      expect.any(Object)
    );
    expect(result.response).toMatchObject({
      status: "success",
      recipe: { title: "Pasted Lentil Soup", sourceType: "unknown" },
      extraction: { strategy: "llm-fallback" },
      quota
    });
    expect(result.headers).toEqual({ "x-linkdish-cache": "bypass" });
  });

  it("does not call the model when billing denies the text import", async () => {
    const extract = vi.fn(() => Promise.resolve(llmCandidate));
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: false,
      commitUsage: vi.fn(),
      logContext: billingLogContext,
      response: {
        status: "failure",
        reason: "plan_limit",
        userMessage: "You have used your free recipe allowance.",
        recovery: { retryable: true, allowFallback: false, suggestedAction: "try_again_later" },
        quota: { ...quota, remaining: 0 }
      }
    });
    const { runtime } = createRuntime();
    runtime.fallbackExtractor = { available: true, providerName: "gemini", extract };

    const result = await runPipeline(runtime, { text: recipeText, attempt: "fallback" });

    expect(result.response).toMatchObject({ status: "failure", reason: "plan_limit" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("commits no usage when the text holds no recipe", async () => {
    const commitUsageWithQuota = vi.fn((response: { status: string }) =>
      Promise.resolve({
        logContext: billingLogContext,
        quota: response.status === "success" ? quota : null
      })
    );
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn(),
      commitUsageWithQuota,
      logContext: billingLogContext
    });
    const { runtime } = createRuntime();

    const result = await runPipeline(runtime, {
      text: "Had the best time at the lake this weekend with everyone!",
      attempt: "fallback"
    });

    expect(result.response).toMatchObject({ status: "failure", reason: "parse_failed" });
    expect(result.response).not.toHaveProperty("quota");
    expect(commitUsageWithQuota).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure" })
    );
  });
});
