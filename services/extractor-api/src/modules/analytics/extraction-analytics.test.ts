import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  getUserById: vi.fn(),
  writeExtractionAnalyticsEvent: vi.fn<(event: AnalyticsExtractionEventInput) => Promise<void>>()
}));

vi.mock("../auth/auth-service.js", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  getUserById: mocks.getUserById
}));

vi.mock("./analytics-store.js", () => ({
  writeExtractionAnalyticsEvent: mocks.writeExtractionAnalyticsEvent
}));

import { recordDurableExtractionAnalyticsEvent } from "./extraction-analytics.js";

import type { AnalyticsExtractionEventInput } from "./analytics-store.js";
import type { AdminExtractionEventInput } from "../admin/metrics.js";

const analyticsEvent: AdminExtractionEventInput = {
  extraction: null,
  billing: {
    accountUserId: null,
    billingClientId: "test-client",
    billingEnabled: true,
    billingQuotaIdentity: "client",
    billingPlan: "free",
    householdId: null,
    householdRole: null,
    meteringMode: "free_lifetime",
    quotaCount: 0,
    quotaKind: "imports",
    quotaLimit: 20
  },
  latencyMs: 123
};

describe("recordDurableExtractionAnalyticsEvent", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("skips durable analytics when the canary marker header is present", async () => {
    await recordDurableExtractionAnalyticsEvent(
      {
        "x-linkdish-canary": "1",
        "x-linkdish-client-id": "regular-client"
      },
      analyticsEvent
    );

    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.writeExtractionAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("skips durable analytics for the default live canary client id", async () => {
    await recordDurableExtractionAnalyticsEvent(
      {
        "x-linkdish-client-id": "live-canary"
      },
      analyticsEvent
    );

    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.writeExtractionAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("records durable analytics for normal extraction requests", async () => {
    mocks.getAuthenticatedUser.mockRejectedValue(new Error("No session"));
    mocks.writeExtractionAnalyticsEvent.mockResolvedValue(undefined);

    await recordDurableExtractionAnalyticsEvent(
      {
        "x-linkdish-app-version": "2.0.5",
        "x-linkdish-build-number": "205",
        "x-linkdish-client-id": "regular-client"
      },
      analyticsEvent,
      {
        correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb"
      }
    );

    const recordedEvent = mocks.writeExtractionAnalyticsEvent.mock.calls[0]?.[0];
    expect(recordedEvent).toMatchObject({
      anonymousId: "regular-client",
      appVersion: "2.0.5",
      buildNumber: "205",
      correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb",
      latencyMs: 123,
      platform: "backend"
    });
    expect(typeof recordedEvent?.occurredAt).toBe("string");
  });

  it("links the event to a signed-in account that still exists", async () => {
    mocks.getUserById.mockResolvedValue({ id: "user_1" });
    mocks.writeExtractionAnalyticsEvent.mockResolvedValue(undefined);

    await recordDurableExtractionAnalyticsEvent(
      {},
      { ...analyticsEvent, billing: { ...analyticsEvent.billing, accountUserId: "user_1" } }
    );

    expect(mocks.getUserById).toHaveBeenCalledWith("user_1");
    expect(mocks.writeExtractionAnalyticsEvent.mock.calls[0]?.[0].accountUserHash).toMatch(
      /^[a-f0-9]{64}$/u
    );
  });

  it("drops the account link when the account was deleted while the extraction ran", async () => {
    mocks.getUserById.mockResolvedValue(null);
    mocks.writeExtractionAnalyticsEvent.mockResolvedValue(undefined);

    await recordDurableExtractionAnalyticsEvent(
      { "x-linkdish-client-id": "regular-client" },
      { ...analyticsEvent, billing: { ...analyticsEvent.billing, accountUserId: "user_1" } }
    );

    const recordedEvent = mocks.writeExtractionAnalyticsEvent.mock.calls[0]?.[0];
    expect(recordedEvent).toMatchObject({ anonymousId: "regular-client" });
    expect(recordedEvent).not.toHaveProperty("accountUserHash");
  });
});
