import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as AuthModule from "./auth.js";

type AuthApi = typeof AuthModule;

let authApi: AuthApi;
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

const billingMocks = vi.hoisted(() => ({
  getRevenueCatBillingPlanId: vi.fn(),
  hasActiveRevenueCatFamilyEntitlement: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/billing/revenuecat-entitlements.js", () => ({
  getRevenueCatBillingPlanId: billingMocks.getRevenueCatBillingPlanId,
  hasActiveRevenueCatFamilyEntitlement: billingMocks.hasActiveRevenueCatFamilyEntitlement
}));

const request = (path: string, email: string, headers?: Record<string, string>) =>
  new Request(`https://api.linkdish.ca/api/auth?path=${path}`, {
    body: JSON.stringify({
      email
    }),
    headers: {
      "content-type": "application/json",
      "x-vercel-forwarded-for": "198.51.100.10",
      ...headers
    },
    method: "POST"
  });

const authenticatedSessionBodySchema = z.object({
  authenticated: z.literal(true),
  user: z.object({
    billingPlan: z.enum(["free", "plus", "family"]).optional(),
    email: z.string(),
    id: z.string()
  })
});

beforeEach(async () => {
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

  authApi = await import("./auth.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel auth adapter", () => {
  it("returns server-controlled auth mode config without requiring households", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_primary");
    vi.stubEnv("HOUSEHOLDS_ENABLED", "false");
    vi.resetModules();
    authApi = await import("./auth.js");

    const response = await authApi.GET(
      new Request("https://api.linkdish.ca/api/auth?path=config")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authMode: "clerk_primary",
      clerkEnabled: true,
      emailCodeEnabled: false
    });
  });

  it("returns Clerk identity linking errors as JSON instead of throwing", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_beta");
    vi.resetModules();
    const { setClerkAuthVerifierForTesting } =
      await import("../services/extractor-api/src/modules/auth/clerk-auth-service.js");
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
          subject: "clerk_unverified_vercel_auth"
        });
      }
    });
    authApi = await import("./auth.js");

    const response = await authApi.GET(
      new Request("https://api.linkdish.ca/api/auth?path=session", {
        headers: {
          authorization: "Bearer header.payload.signature"
        }
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "A verified account email is required to sign in."
    });
  });

  it("returns the server-verified billing plan for Clerk sessions", async () => {
    vi.stubEnv("AUTH_MODE", "clerk_beta");
    vi.resetModules();
    const { setClerkAuthVerifierForTesting } =
      await import("../services/extractor-api/src/modules/auth/clerk-auth-service.js");
    billingMocks.getRevenueCatBillingPlanId.mockResolvedValue("family");
    setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "family-clerk@example.com",
          emailVerified: true,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_family_vercel_auth"
        });
      }
    });
    authApi = await import("./auth.js");

    const response = await authApi.GET(
      new Request("https://api.linkdish.ca/api/auth?path=session", {
        headers: {
          authorization: "Bearer header.payload.signature"
        }
      })
    );
    const body = authenticatedSessionBodySchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      user: {
        billingPlan: "family",
        email: "family-clerk@example.com"
      }
    });
    expect(billingMocks.getRevenueCatBillingPlanId).toHaveBeenCalledWith(body.user.id);
  });

  it("network-throttles login-code requests before sending another code", async () => {
    const firstResponse = await authApi.POST(request("login-code", "first@example.com"));
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      email: "first@example.com",
      status: "sent"
    });

    const secondResponse = await authApi.POST(
      request("login-code", "second@example.com", {
        "x-linkdish-client-id": "rotated-client-id"
      })
    );

    expect(secondResponse.status).toBe(429);
    expect(secondResponse.headers.get("x-ratelimit-limit")).toBe("1");
    await expect(secondResponse.json()).resolves.toMatchObject({
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
  });

  it("returns malformed JSON errors as JSON with a client status", async () => {
    const response = await authApi.POST(
      new Request("https://api.linkdish.ca/api/auth?path=login-code", {
        body: "{",
        headers: {
          "content-type": "application/json",
          "x-vercel-forwarded-for": "198.51.100.20"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: "Request body must be valid JSON."
    });
  });
});
