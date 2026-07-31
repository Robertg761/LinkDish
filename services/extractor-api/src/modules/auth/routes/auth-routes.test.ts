import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

const billingMocks = vi.hoisted(() => ({
  getRevenueCatBillingPlanId: vi.fn(),
  hasActiveRevenueCatFamilyEntitlement: vi.fn()
}));

vi.mock("../../billing/revenuecat-entitlements.js", () => ({
  getRevenueCatBillingPlanId: billingMocks.getRevenueCatBillingPlanId,
  hasActiveRevenueCatFamilyEntitlement: billingMocks.hasActiveRevenueCatFamilyEntitlement
}));

const authenticatedSessionBodySchema = z.object({
  authenticated: z.literal(true),
  expiresAt: z.string(),
  user: z.object({
    billingPlan: z.enum(["free", "plus", "family"]).optional(),
    email: z.string(),
    id: z.string()
  })
});

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_CODE_TTL_SECONDS", "600");
  vi.stubEnv("AUTH_LOGIN_CODE_RATE_LIMIT_MAX", "1");
  vi.stubEnv("AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS", "600000");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
  vi.stubEnv("HOUSEHOLDS_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  billingMocks.getRevenueCatBillingPlanId.mockReset();
  billingMocks.getRevenueCatBillingPlanId.mockResolvedValue("free");
  billingMocks.hasActiveRevenueCatFamilyEntitlement.mockReset();
  billingMocks.hasActiveRevenueCatFamilyEntitlement.mockResolvedValue(false);
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("auth routes", () => {
  it("returns server-controlled auth mode config without requiring a session", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_beta");
    const app = Fastify();
    const { registerAuthRoutes } = await import("./auth-routes.js");
    registerAuthRoutes(app);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/auth/config"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authMode: "clerk_beta",
        clerkEnabled: true,
        emailCodeEnabled: true
      });
    } finally {
      await app.close();
    }
  });

  it("returns the existing session contract for Clerk-authenticated users", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_beta");
    const app = Fastify();
    const { setClerkAuthVerifierForTesting } = await import("../clerk-auth-service.js");
    const { registerAuthRoutes } = await import("./auth-routes.js");

    billingMocks.getRevenueCatBillingPlanId.mockResolvedValue("family");
    setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "route-clerk@example.com",
          emailVerified: true,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_route_user"
        });
      }
    });
    registerAuthRoutes(app);

    try {
      const response = await app.inject({
        headers: {
          authorization: "Bearer header.payload.signature"
        },
        method: "GET",
        url: "/auth/session"
      });

      expect(response.statusCode).toBe(200);
      const rawBody: unknown = response.json();
      const body = authenticatedSessionBodySchema.parse(rawBody);

      expect(body.authenticated).toBe(true);
      expect(body.expiresAt).toBe("2026-06-01T00:00:00.000Z");
      expect(body.user.billingPlan).toBe("family");
      expect(body.user.email).toBe("route-clerk@example.com");
      expect(body.user.id).toMatch(/^user_/u);
      expect(billingMocks.getRevenueCatBillingPlanId).toHaveBeenCalledWith(body.user.id);
    } finally {
      await app.close();
    }
  });

  it("returns Clerk identity linking errors from the session route", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_beta");
    const app = Fastify();
    const { setClerkAuthVerifierForTesting } = await import("../clerk-auth-service.js");
    const { registerAuthRoutes } = await import("./auth-routes.js");

    setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "unverified-clerk@example.com",
          emailVerified: false,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_unverified_route_user"
        });
      }
    });
    registerAuthRoutes(app);

    try {
      const response = await app.inject({
        headers: {
          authorization: "Bearer header.payload.signature"
        },
        method: "GET",
        url: "/auth/session"
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        message: "A verified account email is required to sign in."
      });
    } finally {
      await app.close();
    }
  });

  it("network-throttles login-code requests before sending another code", async () => {
    const app = Fastify();
    const { registerAuthRoutes } = await import("./auth-routes.js");
    registerAuthRoutes(app);

    try {
      const firstResponse = await app.inject({
        headers: {
          "x-forwarded-for": "198.51.100.20"
        },
        method: "POST",
        payload: {
          email: "first@example.com"
        },
        url: "/auth/login-code"
      });
      expect(firstResponse.statusCode).toBe(200);
      expect(firstResponse.json()).toMatchObject({
        email: "first@example.com",
        status: "sent"
      });

      const secondResponse = await app.inject({
        headers: {
          "x-forwarded-for": "198.51.100.20",
          "x-linkdish-client-id": "rotated-client-id"
        },
        method: "POST",
        payload: {
          email: "second@example.com"
        },
        url: "/auth/login-code"
      });

      expect(secondResponse.statusCode).toBe(429);
      expect(secondResponse.headers["x-ratelimit-limit"]).toBe("1");
      expect(secondResponse.json()).toMatchObject({
        message: "Too many sign-in code requests from this network. Please try again shortly."
      });
      expect(
        consoleInfoSpy.mock.calls.filter(([entry]) =>
          typeof entry === "string" ? entry.startsWith("LinkDish login code for ") : false
        )
      ).toHaveLength(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"outcomeStatus":"auth_login_code_rate_limited"')
      );
    } finally {
      await app.close();
    }
  });
});
