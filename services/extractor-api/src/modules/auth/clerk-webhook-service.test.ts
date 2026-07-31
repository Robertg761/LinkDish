import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webhookSecret = "whsec_" + Buffer.from("test_webhook_secret").toString("base64");

const signPayload = (input: { id?: string; rawBody: string; timestamp?: number }) => {
  const id = input.id ?? "msg_test";
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from("test_webhook_secret"))
    .update(`${id}.${timestamp}.${input.rawBody}`)
    .digest("base64");

  return {
    "svix-id": id,
    "svix-signature": `v1,${signature}`,
    "svix-timestamp": timestamp
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("CLERK_WEBHOOK_SECRET", webhookSecret);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("clerk-webhook-service", () => {
  it("rejects invalid webhook signatures", async () => {
    const { handleClerkWebhook } = await import("./clerk-webhook-service.js");
    const rawBody = JSON.stringify({
      data: {
        id: "clerk_bad"
      },
      type: "user.deleted"
    });

    await expect(
      handleClerkWebhook({
        headers: {
          ...signPayload({ rawBody }),
          "svix-signature": "v1,bad"
        },
        rawBody
      })
    ).rejects.toMatchObject({
      message: "Clerk webhook signature is invalid.",
      statusCode: 400
    });
  });

  it("rejects malformed webhook payloads", async () => {
    const { handleClerkWebhook } = await import("./clerk-webhook-service.js");
    const rawBody = "{";

    await expect(
      handleClerkWebhook({
        headers: signPayload({ rawBody }),
        rawBody
      })
    ).rejects.toMatchObject({
      message: "Clerk webhook payload is invalid.",
      statusCode: 400
    });
  });

  it("syncs verified primary email updates for mapped Clerk identities", async () => {
    const { getUserById } = await import("./auth-service.js");
    const { resolveExternalIdentity } = await import("./external-identity-service.js");
    const { handleClerkWebhook } = await import("./clerk-webhook-service.js");
    const user = await resolveExternalIdentity({
      email: "old-clerk@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_update"
    });
    const rawBody = JSON.stringify({
      data: {
        email_addresses: [
          {
            email_address: "new-clerk@example.com",
            id: "email_1",
            verification: {
              status: "verified"
            }
          }
        ],
        id: "clerk_update",
        primary_email_address_id: "email_1"
      },
      type: "user.updated"
    });

    await expect(
      handleClerkWebhook({
        headers: signPayload({ rawBody }),
        rawBody
      })
    ).resolves.toEqual({
      action: "user_updated_updated",
      received: true
    });
    await expect(getUserById(user.id)).resolves.toMatchObject({
      email: "new-clerk@example.com"
    });
  });

  it("acknowledges verified email update conflicts without retrying indefinitely", async () => {
    const { getUserById } = await import("./auth-service.js");
    const { resolveExternalIdentity } = await import("./external-identity-service.js");
    const { handleClerkWebhook } = await import("./clerk-webhook-service.js");
    await resolveExternalIdentity({
      email: "taken-clerk@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_taken"
    });
    const user = await resolveExternalIdentity({
      email: "conflict-old@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_conflict"
    });
    const rawBody = JSON.stringify({
      data: {
        email_addresses: [
          {
            email_address: "taken-clerk@example.com",
            id: "email_conflict",
            verification: {
              status: "verified"
            }
          }
        ],
        id: "clerk_conflict",
        primary_email_address_id: "email_conflict"
      },
      type: "user.updated"
    });

    await expect(
      handleClerkWebhook({
        headers: signPayload({ rawBody }),
        rawBody
      })
    ).resolves.toEqual({
      action: "user_updated_email_conflict",
      received: true
    });
    await expect(getUserById(user.id)).resolves.toMatchObject({
      email: "conflict-old@example.com"
    });
  });

  it("tombstones mapped identities when Clerk users are deleted", async () => {
    const { resolveExternalIdentity } = await import("./external-identity-service.js");
    const { handleClerkWebhook } = await import("./clerk-webhook-service.js");
    await resolveExternalIdentity({
      email: "deleted-clerk@example.com",
      emailVerified: true,
      provider: "clerk",
      subject: "clerk_deleted_webhook"
    });
    const rawBody = JSON.stringify({
      data: {
        id: "clerk_deleted_webhook"
      },
      type: "user.deleted"
    });

    await expect(
      handleClerkWebhook({
        headers: signPayload({ rawBody }),
        rawBody
      })
    ).resolves.toEqual({
      action: "user_deleted_tombstoned",
      received: true
    });
    await expect(
      resolveExternalIdentity({
        email: "deleted-clerk@example.com",
        emailVerified: true,
        provider: "clerk",
        subject: "clerk_deleted_webhook"
      })
    ).rejects.toMatchObject({
      statusCode: 410
    });
  });
});
