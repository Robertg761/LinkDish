import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ANALYTICS_DATABASE_URL", "");
  vi.stubEnv("ANALYTICS_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("analytics-store", () => {
  it("deduplicates provider events by request ID", async () => {
    const { getAnalyticsDashboardSummary, writeAnalyticsEvents } =
      await import("./analytics-store.js");
    const event = {
      eventName: "upgrade_purchased" as const,
      platform: "backend" as const,
      properties: {
        billing_period: "yearly",
        plan: "family"
      },
      requestId: "revenuecat:test-event"
    };

    await expect(writeAnalyticsEvents([event])).resolves.toBe(1);
    await expect(writeAnalyticsEvents([event])).resolves.toBe(0);
    await expect(getAnalyticsDashboardSummary()).resolves.toMatchObject({
      byEventName: {
        upgrade_purchased: 1
      },
      totals: {
        events: 1
      }
    });
  });

  it("summarizes privacy-safe failure dimensions and recent correlated failures", async () => {
    const { getAnalyticsDashboardSummary, writeExtractionAnalyticsEvent } =
      await import("./analytics-store.js");
    const correlationId = "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb";

    await writeExtractionAnalyticsEvent({
      extraction: {
        attempt: "primary",
        blockedSignals: ["cloudflare"],
        browserAttempted: true,
        confidenceScore: null,
        detectionConfidence: "low",
        failureReason: "source_blocked",
        fallbackProvider: "gemini",
        fetchMode: "browser",
        finalUrl: null,
        hostname: "recipes.example.com",
        missingFieldCount: 0,
        outcomeStatus: "failure",
        sourceType: "article",
        statusCode: 403,
        strategy: "none"
      },
      anonymousId: "8ecf51a6-1d7e-43b6-bcf8-0d4478eefb71",
      appVersion: "2.0.5",
      billingPlan: "free",
      buildNumber: "205",
      correlationId,
      latencyMs: 900,
      meteringMode: "free_lifetime",
      occurredAt: "2026-07-30T12:00:00.000Z",
      platform: "android_app",
      sessionId: "f1e6e45d-bf17-47f5-a32c-559314e4e0c8"
    });

    const summary = await getAnalyticsDashboardSummary();

    expect(summary).toMatchObject({
      failureDrilldown: {
        total: 1,
        distinctVisitors: 1,
        distinctSessions: 1,
        byReason: {
          source_blocked: 1
        },
        bySourceHostname: {
          "recipes.example.com": 1
        },
        byPlatform: {
          android_app: 1
        },
        byBuild: {
          "2.0.5 / 205": 1
        },
        recent: [
          expect.objectContaining({
            correlationId,
            reason: "source_blocked",
            sourceHostname: "recipes.example.com"
          })
        ]
      }
    });
    expect(summary.failureDrilldown.recent[0]?.visitorAlias).toMatch(/^visitor-[a-f0-9]{10}$/u);
    expect(summary.failureDrilldown.recent[0]?.sessionAlias).toMatch(/^session-[a-f0-9]{10}$/u);
  });
});
