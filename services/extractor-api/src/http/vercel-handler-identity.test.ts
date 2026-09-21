import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * These cover the serverless (Vercel) adapters under `api/`. They live here so
 * they run with the extractor-api suite, which is the suite that gates the
 * service.
 */
const trustedAddress = "198.51.100.42";
const spoofedHeaders = {
  "cf-connecting-ip": "203.0.113.1",
  "x-forwarded-for": "203.0.113.2",
  "x-real-ip": "203.0.113.3",
  "x-vercel-forwarded-for": "203.0.113.4"
};

const mocks = vi.hoisted(() => ({
  checkPublicEndpointRateLimit: vi.fn(),
  checkLoginCodeRateLimit: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  getProxiedImage: vi.fn(),
  ipAddress: vi.fn(),
  joinIosWaitlist: vi.fn(),
  writeAnalyticsEvents: vi.fn()
}));

vi.mock("@vercel/functions", () => ({
  ipAddress: mocks.ipAddress
}));

vi.mock("../modules/rate-limit/enforce-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPublicEndpointRateLimit: mocks.checkPublicEndpointRateLimit
}));

vi.mock("../modules/auth/login-code-rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkLoginCodeRateLimit: mocks.checkLoginCodeRateLimit
}));

vi.mock("../modules/auth/auth-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAuthenticatedUser: mocks.getAuthenticatedUser
}));

vi.mock("../modules/analytics/analytics-store.js", () => ({
  closeAnalyticsStore: vi.fn(),
  writeAnalyticsEvents: mocks.writeAnalyticsEvents
}));

vi.mock("../modules/image/image-proxy.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProxiedImage: mocks.getProxiedImage
}));

vi.mock("../modules/waitlist/ios-waitlist-service.js", () => ({
  joinIosWaitlist: mocks.joinIosWaitlist
}));

const allowedRateLimit = {
  allowed: true,
  headers: {},
  logContext: {
    rateLimitCount: 1,
    rateLimitIdentity: "network" as const,
    rateLimitLimit: 180,
    rateLimitWindowMs: 60_000
  },
  retryAfterSeconds: 60
};

beforeEach(() => {
  vi.stubEnv("HOUSEHOLDS_ENABLED", "true");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.resetModules();
  mocks.ipAddress.mockReturnValue(trustedAddress);
  mocks.checkPublicEndpointRateLimit.mockResolvedValue(allowedRateLimit);
  mocks.checkLoginCodeRateLimit.mockResolvedValue({
    allowed: true,
    headers: {},
    logContext: {
      loginCodeRateLimitCount: 1,
      loginCodeRateLimitIdentity: "network" as const,
      loginCodeRateLimitLimit: 5,
      loginCodeRateLimitWindowMs: 600_000
    },
    retryAfterSeconds: 600
  });
  mocks.getAuthenticatedUser.mockResolvedValue(null);
  mocks.getProxiedImage.mockResolvedValue(Buffer.from("webp"));
  mocks.writeAnalyticsEvents.mockResolvedValue(1);
  mocks.joinIosWaitlist.mockResolvedValue({
    alreadyJoined: false,
    email: "cook@example.com",
    status: "joined"
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("serverless handlers use the trusted platform address", () => {
  it("/api/image passes the Vercel identity to the rate limiter", async () => {
    const imageApi = await import("../../../../api/image.js");

    await imageApi.GET(
      new Request("https://api.linkdish.ca/image?url=https%3A%2F%2Fimg.test%2Fa.jpg&w=480", {
        headers: spoofedHeaders
      })
    );

    expect(mocks.checkPublicEndpointRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "image" }),
      { remoteAddress: trustedAddress }
    );
  });

  it("/api/analytics passes the Vercel identity to the rate limiter", async () => {
    const analyticsApi = await import("../../../../api/analytics.js");

    await analyticsApi.POST(
      new Request("https://api.linkdish.ca/analytics/events", {
        method: "POST",
        headers: {
          ...spoofedHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          events: [
            {
              eventName: "web_route_viewed",
              occurredAt: "2026-07-11T12:00:00.000Z",
              platform: "web_app",
              properties: {}
            }
          ]
        })
      })
    );

    expect(mocks.checkPublicEndpointRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "analytics" }),
      { remoteAddress: trustedAddress }
    );
  });

  it("/api/support-ticket passes the Vercel identity to the rate limiter", async () => {
    const supportApi = await import("../../../../api/support-ticket.js");

    await supportApi.POST(
      new Request("https://api.linkdish.ca/support-ticket", {
        method: "POST",
        headers: {
          ...spoofedHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "cook@example.com",
          message: "The importer failed on my recipe link.",
          topic: "bug"
        })
      })
    );

    expect(mocks.checkPublicEndpointRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "support-ticket" }),
      { remoteAddress: trustedAddress }
    );
  });

  it("/api/auth login-code passes the Vercel identity to the rate limiter", async () => {
    const authApi = await import("../../../../api/auth.js");

    await authApi.POST(
      new Request("https://api.linkdish.ca/auth?path=login-code", {
        method: "POST",
        headers: {
          ...spoofedHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify({ email: "cook@example.com" })
      })
    );

    expect(mocks.checkLoginCodeRateLimit).toHaveBeenCalledWith(expect.anything(), {
      remoteAddress: trustedAddress
    });
  });

  it("/api/ios-waitlist passes the Vercel identity to the waitlist service", async () => {
    const waitlistApi = await import("../../../../api/ios-waitlist.js");

    await waitlistApi.POST(
      new Request("https://api.linkdish.ca/ios-waitlist", {
        method: "POST",
        headers: {
          ...spoofedHeaders,
          "content-type": "application/json"
        },
        body: JSON.stringify({ email: "cook@example.com" })
      })
    );

    expect(mocks.joinIosWaitlist).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      remoteAddress: trustedAddress
    });
  });
});
