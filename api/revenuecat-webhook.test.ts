import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BillingModule from "./billing.js";

type BillingApi = typeof BillingModule;

const authorization = "Bearer test-revenuecat-webhook";
const signingSecret = "test_revenuecat_signing_secret";
let billingApi: BillingApi;

const request = (rawBody: string) => {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  return new Request("https://api.linkdish.ca/api/billing?path=revenuecat-webhook", {
    body: rawBody,
    headers: {
      authorization,
      "content-type": "application/json",
      "x-revenuecat-webhook-signature": `t=${timestamp},v1=${signature}`
    },
    method: "POST"
  });
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("ANALYTICS_DATABASE_URL", "");
  vi.stubEnv("ANALYTICS_ENABLED", "true");
  vi.stubEnv("ANALYTICS_HASH_SECRET", "test_analytics_hash_secret");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("REVENUECAT_WEBHOOK_AUTHORIZATION", authorization);
  vi.stubEnv("REVENUECAT_WEBHOOK_SIGNING_SECRET", signingSecret);

  billingApi = await import("./billing.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Vercel RevenueCat webhook billing adapter", () => {
  it("verifies and records a production purchase payload", async () => {
    const rawBody = JSON.stringify({
      api_version: "1.0",
      event: {
        app_user_id: "user_123",
        entitlement_ids: ["Plus"],
        environment: "PRODUCTION",
        event_timestamp_ms: 1_782_167_400_000,
        expiration_at_ms: 1_784_759_400_000,
        id: "event_plus_monthly",
        product_id: "linkdish_plus:monthly",
        purchased_at_ms: 1_782_167_400_000,
        type: "INITIAL_PURCHASE"
      }
    });
    const response = await billingApi.POST(request(rawBody));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: "purchase_recorded",
      received: true
    });
  });
});
