import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RateLimitModule from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

const mocks = vi.hoisted(() => ({
  checkPublicEndpointRateLimit: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  writeAnalyticsEvents: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>(
    "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js"
  );

  return {
    ...actual,
    checkPublicEndpointRateLimit: mocks.checkPublicEndpointRateLimit
  };
});

vi.mock("../services/extractor-api/src/modules/auth/auth-service.js", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser
}));

vi.mock("../services/extractor-api/src/modules/analytics/analytics-store.js", () => ({
  writeAnalyticsEvents: mocks.writeAnalyticsEvents
}));

const request = () =>
  new Request("https://api.linkdish.ca/analytics/events", {
    body: JSON.stringify({
      events: [
        {
          eventName: "web_route_viewed",
          occurredAt: "2026-07-11T12:00:00.000Z",
          platform: "web_app",
          properties: {}
        }
      ]
    }),
    headers: {
      "content-type": "application/json",
      origin: "https://app.linkdish.ca"
    },
    method: "POST"
  });

beforeEach(() => {
  mocks.checkPublicEndpointRateLimit.mockResolvedValue({
    allowed: true,
    headers: {},
    logContext: {
      rateLimitCount: 1,
      rateLimitIdentity: "network",
      rateLimitLimit: 180,
      rateLimitWindowMs: 60_000
    },
    retryAfterSeconds: 60
  });
  mocks.getAuthenticatedUser.mockResolvedValue(null);
  mocks.writeAnalyticsEvents.mockResolvedValue(1);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Vercel analytics adapter", () => {
  it("writes a valid event after the abuse check", async () => {
    const analyticsApi = await import("./analytics.js");
    const response = await analyticsApi.POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(response.json()).resolves.toEqual({ accepted: 1 });
    expect(mocks.checkPublicEndpointRateLimit).toHaveBeenCalledOnce();
    expect(mocks.writeAnalyticsEvents).toHaveBeenCalledOnce();
  });

  it("allows credentialed web analytics preflights", async () => {
    const analyticsApi = await import("./analytics.js");
    const response = analyticsApi.OPTIONS(
      new Request("https://api.linkdish.ca/analytics/events", {
        headers: {
          origin: "https://linkdish.ca"
        },
        method: "OPTIONS"
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://linkdish.ca");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects events over the network limit", async () => {
    mocks.checkPublicEndpointRateLimit.mockResolvedValue({
      allowed: false,
      headers: {
        "retry-after": "60",
        "x-ratelimit-limit": "180",
        "x-ratelimit-remaining": "0"
      },
      logContext: {
        rateLimitCount: 181,
        rateLimitIdentity: "network",
        rateLimitLimit: 180,
        rateLimitWindowMs: 60_000
      },
      retryAfterSeconds: 60
    });
    const analyticsApi = await import("./analytics.js");
    const response = await analyticsApi.POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(mocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });
});
