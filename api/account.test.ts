import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AccountModule from "./account.js";

type AccountApi = typeof AccountModule;

let accountApi: AccountApi;

const billingMocks = vi.hoisted(() => ({
  getRevenueCatBillingPlanId: vi.fn(),
  hasActiveRevenueCatFamilyEntitlement: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/billing/revenuecat-entitlements.js", () => ({
  getRevenueCatBillingPlanId: billingMocks.getRevenueCatBillingPlanId,
  hasActiveRevenueCatFamilyEntitlement: billingMocks.hasActiveRevenueCatFamilyEntitlement
}));

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_MODE", "clerk_beta");
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
        subject: "clerk_unverified_vercel_account"
      });
    }
  });

  accountApi = await import("./account.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel account adapter", () => {
  it("updates the authenticated profile", async () => {
    const { setClerkAuthVerifierForTesting } =
      await import("../services/extractor-api/src/modules/auth/clerk-auth-service.js");
    billingMocks.getRevenueCatBillingPlanId.mockResolvedValue("family");
    setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "profile-clerk@example.com",
          emailVerified: true,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_profile_vercel_account"
        });
      }
    });

    const response = await accountApi.PATCH(
      new Request("https://api.linkdish.ca/api/account", {
        body: JSON.stringify({
          avatarEmoji: "🥘",
          displayName: " Profile Cook "
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        avatarEmoji: "🥘",
        billingPlan: "family",
        displayName: "Profile Cook",
        email: "profile-clerk@example.com"
      }
    });
    expect(billingMocks.getRevenueCatBillingPlanId).toHaveBeenCalled();
  });

  it("returns malformed JSON errors as JSON with a client status", async () => {
    const { setClerkAuthVerifierForTesting } =
      await import("../services/extractor-api/src/modules/auth/clerk-auth-service.js");
    setClerkAuthVerifierForTesting({
      getExternalIdentity(subject) {
        return Promise.resolve({
          email: "profile-json@example.com",
          emailVerified: true,
          subject
        });
      },
      verifySessionToken() {
        return Promise.resolve({
          expiresAt: "2026-06-01T00:00:00.000Z",
          subject: "clerk_profile_json_error"
        });
      }
    });

    const response = await accountApi.PATCH(
      new Request("https://api.linkdish.ca/api/account", {
        body: "{",
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "PATCH"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: "Request body must be valid JSON."
    });
  });

  it("returns Clerk identity linking errors as JSON instead of throwing", async () => {
    const response = await accountApi.DELETE(
      new Request("https://api.linkdish.ca/api/account", {
        body: JSON.stringify({
          confirmEmail: "unverified-clerk@example.com"
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "DELETE"
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: "A verified account email is required to sign in."
    });
  });
});
