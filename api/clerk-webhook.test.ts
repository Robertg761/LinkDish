import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ClerkWebhookModule from "./clerk-webhook.js";

type ClerkWebhookApi = typeof ClerkWebhookModule;

let clerkWebhookApi: ClerkWebhookApi;

const webhookSecret = "whsec_" + Buffer.from("test_webhook_secret").toString("base64");

const request = (rawBody: string, headers?: Record<string, string>) => {
  const id = "msg_vercel";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from("test_webhook_secret"))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  return new Request("https://api.linkdish.ca/api/clerk-webhook", {
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-signature": `v1,${signature}`,
      "svix-timestamp": timestamp,
      ...headers
    },
    method: "POST"
  });
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("CLERK_WEBHOOK_SECRET", webhookSecret);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");

  clerkWebhookApi = await import("./clerk-webhook.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Vercel Clerk webhook adapter", () => {
  it("verifies and handles Clerk webhook payloads from the raw request body", async () => {
    const response = await clerkWebhookApi.POST(
      request(
        JSON.stringify({
          data: {
            id: "clerk_unmapped"
          },
          type: "user.deleted"
        })
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      action: "user_deleted_not_mapped",
      received: true
    });
  });
});
