import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockRateLimitUnavailableError extends Error {}

  return {
    authorizeExtractionRequest: vi.fn(),
    checkExtractRateLimit: vi.fn(),
    extractRecipe: vi.fn(),
    ipAddress: vi.fn(),
    recordDurableExtractionAnalyticsEvent: vi.fn(),
    RateLimitUnavailableError: MockRateLimitUnavailableError,
    waitUntil: vi.fn()
  };
});

vi.mock("@vercel/functions", () => ({
  ipAddress: mocks.ipAddress,
  waitUntil: mocks.waitUntil
}));

vi.mock("../services/extractor-api/src/modules/billing/enforce-billing.js", () => ({
  authorizeExtractionRequest: mocks.authorizeExtractionRequest
}));

vi.mock("../services/extractor-api/src/modules/extract/services/extract-recipe.js", () => ({
  extractRecipe: mocks.extractRecipe
}));

vi.mock("../services/extractor-api/src/modules/analytics/extraction-analytics.js", () => ({
  recordDurableExtractionAnalyticsEvent: mocks.recordDurableExtractionAnalyticsEvent
}));

vi.mock("../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js", () => ({
  checkExtractRateLimit: mocks.checkExtractRateLimit,
  RateLimitUnavailableError: mocks.RateLimitUnavailableError
}));

const createRequest = (correlationId?: string, headers: Record<string, string> = {}) =>
  new Request("https://api.linkdish.ca/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.200",
      "x-linkdish-client-id": "free-user",
      ...headers
    },
    body: JSON.stringify({
      attempt: "primary",
      url: "https://example.com/recipe",
      ...(correlationId ? { correlationId } : {})
    })
  });

const extractionLogContext = {
  hostname: "example.com",
  sourceType: "recipe-webpage",
  detectionConfidence: "high",
  attempt: "primary",
  outcomeStatus: "failure",
  strategy: "none",
  fetchMode: "http",
  confidenceScore: null,
  missingFieldCount: 0,
  fallbackProvider: "none",
  failureReason: "parse_failed",
  statusCode: 200,
  finalUrl: "https://example.com/recipe",
  blockedSignals: [],
  browserAttempted: false,
  cacheStatus: "miss"
};

const allowedBilling = (
  commitUsage = vi.fn().mockResolvedValue({ billingClientId: "free-user" })
) => ({
  allowed: true,
  commitUsage,
  logContext: {
    billingClientId: "free-user"
  }
});

describe("Vercel extract adapter request identity", () => {
  beforeEach(() => {
    mocks.ipAddress.mockReturnValue(undefined);
    mocks.checkExtractRateLimit.mockResolvedValue({
      allowed: true,
      headers: {},
      logContext: {
        rateLimitCount: 1,
        rateLimitIdentity: "network",
        rateLimitLimit: 10,
        rateLimitWindowMs: 60_000
      },
      retryAfterSeconds: 60
    });
    mocks.authorizeExtractionRequest.mockResolvedValue(allowedBilling());
    mocks.extractRecipe.mockResolvedValue({
      logContext: extractionLogContext,
      response: {
        reason: "parse_failed",
        status: "failure",
        userMessage: "No recipe found."
      }
    });
    mocks.recordDurableExtractionAnalyticsEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes Vercel's trusted IP helper result to rate limiting and billing", async () => {
    mocks.ipAddress.mockReturnValue("198.51.100.3 ");
    const extractApi = await import("./extract.js");

    await extractApi.POST(createRequest());

    expect(mocks.checkExtractRateLimit).toHaveBeenCalledWith(expect.any(Headers), {
      remoteAddress: "198.51.100.3"
    });
    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledWith(expect.any(Headers), "primary", {
      remoteAddress: "198.51.100.3"
    });
  });

  it("uses explicit unknown identity instead of falling back to spoofed forwarded headers", async () => {
    const extractApi = await import("./extract.js");

    await extractApi.POST(createRequest());

    expect(mocks.checkExtractRateLimit).toHaveBeenCalledWith(expect.any(Headers), {
      remoteAddress: "unknown"
    });
    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledWith(expect.any(Headers), "primary", {
      remoteAddress: "unknown"
    });
  });

  it("responds before durable analytics finish and hands the write to waitUntil", async () => {
    const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";
    let releaseAnalytics: (() => void) | undefined;
    mocks.recordDurableExtractionAnalyticsEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAnalytics = resolve;
        })
    );
    const extractApi = await import("./extract.js");

    /* The analytics write is still pending, yet the response is already here. */
    const response = await extractApi.POST(createRequest(correlationId));

    expect(response.status).toBe(200);
    expect(mocks.recordDurableExtractionAnalyticsEvent).toHaveBeenCalledWith(
      expect.any(Headers),
      expect.any(Object),
      {
        correlationId
      }
    );
    expect(mocks.waitUntil).toHaveBeenCalledWith(expect.any(Promise));

    const scheduledTasks = mocks.waitUntil.mock.calls.map(([task]) => task as Promise<unknown>);
    let analyticsSettled = false;
    void Promise.all(scheduledTasks).then(() => {
      analyticsSettled = true;
    });
    await Promise.resolve();
    expect(analyticsSettled).toBe(false);

    releaseAnalytics?.();
    await Promise.all(scheduledTasks);
  });

  it("starts the extraction alongside billing and passes waitUntil for post-response work", async () => {
    const extractApi = await import("./extract.js");
    let resolveBilling: ((value: ReturnType<typeof allowedBilling>) => void) | undefined;
    mocks.authorizeExtractionRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBilling = resolve;
      })
    );

    const responsePromise = extractApi.POST(createRequest("5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"));

    await vi.waitFor(() => {
      expect(mocks.extractRecipe).toHaveBeenCalled();
    });
    expect(mocks.authorizeExtractionRequest).toHaveBeenCalled();

    const [, , options] = mocks.extractRecipe.mock.calls[0] as [
      unknown,
      unknown,
      {
        authorization: Promise<boolean>;
        cacheMode: string;
        correlationId: string;
        schedule: (task: Promise<unknown>) => void;
        signal: AbortSignal;
      }
    ];

    expect(options.correlationId).toBe("5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb");
    expect(options.cacheMode).toBe("default");
    expect(options.signal.aborted).toBe(false);

    const scheduledTask = Promise.resolve();
    options.schedule(scheduledTask);
    expect(mocks.waitUntil).toHaveBeenCalledWith(scheduledTask);

    resolveBilling?.(allowedBilling());
    await expect(options.authorization).resolves.toBe(true);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("x-linkdish-cache")).toBe("miss");
  });

  it("cancels the speculative extraction and skips usage when billing denies", async () => {
    const commitUsage = vi.fn();
    mocks.authorizeExtractionRequest.mockResolvedValueOnce({
      allowed: false,
      commitUsage,
      logContext: {
        billingClientId: "free-user",
        billingPlan: "free"
      },
      response: {
        reason: "plan_limit",
        recovery: {
          allowFallback: false,
          retryable: true,
          suggestedAction: "try_again_later"
        },
        status: "failure",
        userMessage: "You have used your free recipe allowance."
      }
    });
    const extractApi = await import("./extract.js");

    const response = await extractApi.POST(createRequest());
    const [, , options] = mocks.extractRecipe.mock.calls[0] as [
      unknown,
      unknown,
      { authorization: Promise<boolean>; signal: AbortSignal }
    ];

    await expect(response.json()).resolves.toMatchObject({
      reason: "plan_limit",
      status: "failure"
    });
    expect(options.signal.aborted).toBe(true);
    await expect(options.authorization).resolves.toBe(false);
    expect(commitUsage).not.toHaveBeenCalled();
    expect(mocks.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("accepts pasted text and meters it like an explicit fallback attempt", async () => {
    const extractApi = await import("./extract.js");
    const text = "Lentil soup: 1 cup red lentils, 4 cups stock. Simmer for 25 minutes.";

    const response = await extractApi.POST(
      new Request("https://api.linkdish.ca/extract", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-linkdish-client-id": "free-user"
        },
        body: JSON.stringify({ text })
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.extractRecipe).toHaveBeenCalledWith(
      { text, attempt: "fallback" },
      undefined,
      expect.any(Object)
    );
    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledWith(
      expect.any(Headers),
      "fallback",
      expect.any(Object)
    );
  });

  it("rejects pasted text outside the length bounds", async () => {
    const extractApi = await import("./extract.js");

    const response = await extractApi.POST(
      new Request("https://api.linkdish.ca/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "too short" })
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.extractRecipe).not.toHaveBeenCalled();
  });

  it("returns the committed quota with a success", async () => {
    const quota = {
      limit: 3,
      remaining: 2,
      monthlyLimit: null,
      remainingThisMonth: null,
      resetsAt: null,
      meteringMode: "free_lifetime"
    };
    mocks.authorizeExtractionRequest.mockResolvedValueOnce({
      ...allowedBilling(),
      commitUsageWithQuota: vi
        .fn()
        .mockResolvedValue({ logContext: { billingClientId: "free-user" }, quota })
    });
    mocks.extractRecipe.mockResolvedValueOnce({
      logContext: { ...extractionLogContext, outcomeStatus: "success" },
      response: {
        status: "success",
        recipe: { title: "Soup" },
        extraction: { sourceType: "article" }
      }
    });
    const extractApi = await import("./extract.js");

    const response = await extractApi.POST(createRequest());

    await expect(response.json()).resolves.toMatchObject({ status: "success", quota });
  });

  it("reads around the result cache only for the token-verified live canary", async () => {
    const { extractorApiEnv } = await import("../services/extractor-api/src/config/env.js");
    const originalCanaryToken = extractorApiEnv.LINKDISH_CANARY_TOKEN;
    extractorApiEnv.LINKDISH_CANARY_TOKEN = "canary-secret-token";
    const extractApi = await import("./extract.js");

    try {
      await extractApi.POST(
        createRequest(undefined, {
          authorization: "Bearer canary-secret-token",
          "x-linkdish-canary": "1"
        })
      );
      /* The bare marker is caller-controlled: it must not let anyone refresh shared entries. */
      await extractApi.POST(createRequest(undefined, { "x-linkdish-canary": "1" }));
    } finally {
      extractorApiEnv.LINKDISH_CANARY_TOKEN = originalCanaryToken;
    }

    expect(mocks.extractRecipe).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      undefined,
      expect.objectContaining({ cacheMode: "refresh" })
    );
    expect(mocks.extractRecipe).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      undefined,
      expect.objectContaining({ cacheMode: "default" })
    );
  });
});
