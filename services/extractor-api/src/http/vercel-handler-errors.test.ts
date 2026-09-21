import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Unclassified failures must not hand Upstash/Postgres/Resend internals back to
 * the client. These cover the serverless (Vercel) adapters under `api/`.
 */
const internalMessage = "connect ECONNREFUSED 10.0.0.7:6379 (upstash-internal)";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  handleRevenueCatWebhook: vi.fn(),
  joinIosWaitlist: vi.fn(),
  updateUserProfileById: vi.fn(),
  getHouseholdOverviewForUser: vi.fn()
}));

vi.mock("../modules/auth/auth-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  updateUserProfileById: mocks.updateUserProfileById
}));

vi.mock("../modules/billing/revenuecat-webhook-service.js", () => ({
  handleRevenueCatWebhook: mocks.handleRevenueCatWebhook
}));

vi.mock("../modules/waitlist/ios-waitlist-service.js", () => ({
  joinIosWaitlist: mocks.joinIosWaitlist
}));

vi.mock("../modules/households/household-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHouseholdOverviewForUser: mocks.getHouseholdOverviewForUser
}));

const expectNoLeak = async (response: Response) => {
  const body = (await response.json()) as { message?: string };

  expect(response.status).toBe(500);
  expect(body.message).not.toContain("ECONNREFUSED");
  expect(body.message).not.toContain("upstash-internal");
  expect(body.message).toMatch(/unexpected|try again/iu);
};

beforeEach(() => {
  vi.stubEnv("HOUSEHOLDS_ENABLED", "true");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.getAuthenticatedUser.mockRejectedValue(new Error(internalMessage));
  mocks.handleRevenueCatWebhook.mockRejectedValue(new Error(internalMessage));
  mocks.joinIosWaitlist.mockRejectedValue(new Error(internalMessage));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("serverless handlers hide internal failures", () => {
  it("/api/billing returns a generic 500", async () => {
    const billingApi = await import("../../../../api/billing.js");

    await expectNoLeak(
      await billingApi.POST(
        new Request("https://api.linkdish.ca/billing?path=revenuecat-webhook", {
          method: "POST",
          body: "{}"
        })
      )
    );
  });

  it("/api/account returns a generic 500", async () => {
    const accountApi = await import("../../../../api/account.js");

    await expectNoLeak(
      await accountApi.PATCH(
        new Request("https://api.linkdish.ca/account", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: "Cook" })
        })
      )
    );
  });

  it("/api/household returns a generic 500", async () => {
    const householdApi = await import("../../../../api/household.js");

    await expectNoLeak(
      await householdApi.GET(new Request("https://api.linkdish.ca/household?path=overview"))
    );
  });

  it("/api/auth returns a generic 500", async () => {
    const authApi = await import("../../../../api/auth.js");

    await expectNoLeak(
      await authApi.GET(new Request("https://api.linkdish.ca/auth?path=session"))
    );
  });

  it("/api/ios-waitlist returns a generic 500", async () => {
    const waitlistApi = await import("../../../../api/ios-waitlist.js");

    await expectNoLeak(
      await waitlistApi.POST(
        new Request("https://api.linkdish.ca/ios-waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "cook@example.com" })
        })
      )
    );
  });

  it("still reports classified errors with their own message", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const accountApi = await import("../../../../api/account.js");
    const response = await accountApi.PATCH(
      new Request("https://api.linkdish.ca/account", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Cook" })
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Sign in is required."
    });
  });
});
