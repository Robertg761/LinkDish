import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedAnalyticsEvent {
  accountUserHash?: string;
  requestId?: string;
}

const analyticsMocks = vi.hoisted(() => ({
  writeAnalyticsEvents: vi.fn<(events: RecordedAnalyticsEvent[]) => Promise<number>>()
}));

vi.mock("../analytics/analytics-store.js", () => ({
  writeAnalyticsEvents: analyticsMocks.writeAnalyticsEvents
}));

const authorization = "Bearer test-revenuecat-webhook";
const signingSecret = "test_revenuecat_signing_secret";

const signPayload = (rawBody: string, timestamp = Math.floor(Date.now() / 1_000)) => ({
  authorization,
  "x-revenuecat-webhook-signature": `t=${timestamp},v1=${createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`
});

const buildPayload = (event: Record<string, unknown> = {}) =>
  JSON.stringify({
    api_version: "1.0",
    event: {
      app_user_id: "linkdish_user_123",
      entitlement_ids: ["Family"],
      environment: "PRODUCTION",
      event_timestamp_ms: 1_782_167_400_000,
      expiration_at_ms: 1_813_703_400_000,
      id: "event_family_yearly",
      product_id: "linkdish_family:yearly",
      purchased_at_ms: 1_782_167_400_000,
      type: "INITIAL_PURCHASE",
      ...event
    }
  });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ANALYTICS_ENABLED", "true");
  vi.stubEnv("ANALYTICS_HASH_SECRET", "test_analytics_hash_secret");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("REVENUECAT_FAMILY_ENTITLEMENT_ID", "Family");
  vi.stubEnv("REVENUECAT_PLUS_ENTITLEMENT_ID", "Plus");
  vi.stubEnv("REVENUECAT_WEBHOOK_AUTHORIZATION", authorization);
  vi.stubEnv("REVENUECAT_WEBHOOK_SIGNING_SECRET", signingSecret);
  analyticsMocks.writeAnalyticsEvents.mockReset();
  analyticsMocks.writeAnalyticsEvents.mockResolvedValue(1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("revenuecat-webhook-service", () => {
  it("rejects invalid authorization before processing the payload", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload();

    await expect(
      handleRevenueCatWebhook({
        headers: {
          ...signPayload(rawBody),
          authorization: "Bearer wrong"
        },
        rawBody
      })
    ).rejects.toMatchObject({
      message: "RevenueCat webhook authorization is invalid.",
      statusCode: 401
    });
    expect(analyticsMocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });

  it("rejects invalid HMAC signatures", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload();

    await expect(
      handleRevenueCatWebhook({
        headers: {
          ...signPayload(rawBody),
          "x-revenuecat-webhook-signature": `t=${Math.floor(Date.now() / 1_000)},v1=${"0".repeat(64)}`
        },
        rawBody
      })
    ).rejects.toMatchObject({
      message: "RevenueCat webhook signature is invalid.",
      statusCode: 401
    });
  });

  it("records a privacy-safe server-confirmed purchase event", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload();

    await expect(
      handleRevenueCatWebhook({
        headers: signPayload(rawBody),
        rawBody
      })
    ).resolves.toEqual({
      action: "purchase_recorded",
      received: true
    });
    expect(analyticsMocks.writeAnalyticsEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        eventName: "upgrade_purchased",
        platform: "backend",
        properties: {
          billing_period: "yearly",
          plan: "family"
        },
        routeOrScreen: "/webhooks/revenuecat"
      })
    ]);
    const recordedEvent = analyticsMocks.writeAnalyticsEvents.mock.calls[0]?.[0][0];
    expect(recordedEvent?.accountUserHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(recordedEvent?.requestId).toMatch(/^revenuecat:[a-f0-9]{64}$/u);
    expect(JSON.stringify(analyticsMocks.writeAnalyticsEvents.mock.calls)).not.toContain(
      "linkdish_user_123"
    );
  });

  it("records the founding one-time purchase as lifetime Plus", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload({
      entitlement_ids: ["Plus"],
      expiration_at_ms: null,
      id: "event_founding",
      product_id: "linkdish_plus_founding_lifetime",
      type: "NON_RENEWING_PURCHASE"
    });

    await handleRevenueCatWebhook({
      headers: signPayload(rawBody),
      rawBody
    });

    expect(analyticsMocks.writeAnalyticsEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        properties: {
          billing_period: "lifetime",
          plan: "plus",
          trigger: "founding"
        }
      })
    ]);
  });

  it.each([
    { period_type: "PROMOTIONAL", store: null },
    { period_type: "normal", store: "PROMOTIONAL" }
  ])(
    "does not count promotional entitlement grants as paid purchases (%o)",
    async (promotionMarkers) => {
      const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
      const rawBody = buildPayload({
        expiration_at_ms: 1_813_703_400_000,
        product_id: null,
        type: "NON_RENEWING_PURCHASE",
        ...promotionMarkers
      });

      await expect(
        handleRevenueCatWebhook({
          headers: signPayload(rawBody),
          rawBody
        })
      ).resolves.toEqual({
        action: "ignored_promotional",
        received: true
      });
      expect(analyticsMocks.writeAnalyticsEvents).not.toHaveBeenCalled();
    }
  );

  it("acknowledges non-purchase lifecycle events without recording conversions", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload({ type: "RENEWAL" });

    await expect(
      handleRevenueCatWebhook({
        headers: signPayload(rawBody),
        rawBody
      })
    ).resolves.toEqual({
      action: "ignored",
      received: true
    });
    expect(analyticsMocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });

  it("accepts RevenueCat test payloads with null entitlement IDs", async () => {
    const { handleRevenueCatWebhook } = await import("./revenuecat-webhook-service.js");
    const rawBody = buildPayload({
      entitlement_id: null,
      entitlement_ids: null,
      environment: "SANDBOX"
    });

    await expect(
      handleRevenueCatWebhook({
        headers: signPayload(rawBody),
        rawBody
      })
    ).resolves.toEqual({
      action: "ignored_non_production",
      received: true
    });
    expect(analyticsMocks.writeAnalyticsEvents).not.toHaveBeenCalled();
  });
});
