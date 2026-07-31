import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockRateLimitUnavailableError extends Error {}

  return {
    authorizeExtractionRequest: vi.fn(),
    checkExtractRateLimit: vi.fn(),
    extractRecipe: vi.fn(),
    ipAddress: vi.fn(),
    recordDurableExtractionAnalyticsEvent: vi.fn(),
    RateLimitUnavailableError: MockRateLimitUnavailableError
  };
});

vi.mock("@vercel/functions", () => ({
  ipAddress: mocks.ipAddress
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

const createRequest = (correlationId?: string) =>
  new Request("https://api.linkdish.ca/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.200",
      "x-linkdish-client-id": "free-user"
    },
    body: JSON.stringify({
      attempt: "primary",
      url: "https://example.com/recipe",
      ...(correlationId ? { correlationId } : {})
    })
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
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn().mockResolvedValue({
        billingClientId: "free-user"
      }),
      logContext: {
        billingClientId: "free-user"
      }
    });
    mocks.extractRecipe.mockResolvedValue({
      logContext: {},
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

  it("awaits durable analytics and forwards the import correlation ID", async () => {
    const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";
    let releaseAnalytics: (() => void) | undefined;
    mocks.recordDurableExtractionAnalyticsEvent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseAnalytics = resolve;
        })
    );
    const extractApi = await import("./extract.js");
    let settled = false;
    const responsePromise = extractApi.POST(createRequest(correlationId)).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => {
      expect(mocks.recordDurableExtractionAnalyticsEvent).toHaveBeenCalled();
    });
    expect(settled).toBe(false);
    expect(mocks.recordDurableExtractionAnalyticsEvent).toHaveBeenCalledWith(
      expect.any(Headers),
      expect.any(Object),
      {
        correlationId
      }
    );

    releaseAnalytics?.();
    await responsePromise;
    expect(settled).toBe(true);
  });
});
