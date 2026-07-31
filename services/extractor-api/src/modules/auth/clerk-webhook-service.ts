import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { extractorApiEnv } from "../../config/env.js";
import { getHeader, type RequestHeaders } from "../request-identity.js";

import { AuthError } from "./auth-service.js";
import {
  syncMappedExternalIdentityEmail,
  tombstoneExternalIdentity
} from "./external-identity-service.js";

const maxTimestampSkewSeconds = 300;

const clerkEmailAddressSchema = z
  .object({
    email_address: z.string().email(),
    id: z.string().min(1),
    verification: z
      .object({
        status: z.string().optional()
      })
      .optional()
  })
  .passthrough();

const clerkWebhookEventSchema = z
  .object({
    data: z
      .object({
        email_addresses: z.array(clerkEmailAddressSchema).optional(),
        id: z.string().min(1),
        primary_email_address_id: z.string().nullable().optional()
      })
      .passthrough(),
    type: z.string().min(1)
  })
  .passthrough();

type ClerkWebhookEvent = z.infer<typeof clerkWebhookEventSchema>;

export class ClerkWebhookError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "ClerkWebhookError";
  }
}

const getWebhookHeader = (headers: RequestHeaders, name: string): string | null =>
  getHeader(headers, name) ?? getHeader(headers, name.replace(/^webhook-/u, "svix-"));

const getSigningSecret = (): Buffer => {
  const secret = extractorApiEnv.CLERK_WEBHOOK_SECRET;

  if (!secret) {
    throw new ClerkWebhookError("Clerk webhook signing secret is not configured.", 503);
  }

  return Buffer.from(secret.replace(/^whsec_/u, ""), "base64");
};

const constantTimeBase64Equals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const verifyClerkWebhookSignature = (input: {
  headers: RequestHeaders;
  rawBody: string;
}): void => {
  const messageId = getWebhookHeader(input.headers, "webhook-id");
  const timestamp = getWebhookHeader(input.headers, "webhook-timestamp");
  const signatureHeader = getWebhookHeader(input.headers, "webhook-signature");

  if (!messageId || !timestamp || !signatureHeader) {
    throw new ClerkWebhookError("Clerk webhook signature headers are missing.", 400);
  }

  const timestampSeconds = Number(timestamp);

  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(Date.now() / 1000 - timestampSeconds) > maxTimestampSkewSeconds
  ) {
    throw new ClerkWebhookError("Clerk webhook timestamp is outside the allowed window.", 400);
  }

  const expectedSignature = createHmac("sha256", getSigningSecret())
    .update(`${messageId}.${timestamp}.${input.rawBody}`)
    .digest("base64");

  const signatures = signatureHeader
    .split(/\s+/u)
    .map((signature) => signature.trim())
    .filter(Boolean)
    .map((signature) => signature.replace(/^v\d+,/u, ""));

  if (!signatures.some((signature) => constantTimeBase64Equals(signature, expectedSignature))) {
    throw new ClerkWebhookError("Clerk webhook signature is invalid.", 400);
  }
};

const getVerifiedPrimaryEmail = (event: ClerkWebhookEvent): string | null => {
  const primaryEmail =
    event.data.email_addresses?.find(
      (emailAddress) => emailAddress.id === event.data.primary_email_address_id
    ) ?? event.data.email_addresses?.[0];

  if (!primaryEmail || primaryEmail.verification?.status !== "verified") {
    return null;
  }

  return primaryEmail.email_address;
};

export const handleVerifiedClerkWebhook = async (
  event: ClerkWebhookEvent
): Promise<{ action: string; received: true }> => {
  if (event.type === "user.deleted") {
    const result = await tombstoneExternalIdentity("clerk", event.data.id);
    return {
      action: `user_deleted_${result.status}`,
      received: true
    };
  }

  if (event.type === "user.updated") {
    const email = getVerifiedPrimaryEmail(event);

    if (!email) {
      return {
        action: "user_updated_no_verified_primary_email",
        received: true
      };
    }

    const result = await syncMappedExternalIdentityEmail("clerk", event.data.id, email).catch(
      (error: unknown) => {
        if (error instanceof AuthError && error.statusCode === 409) {
          return {
            status: "email_conflict" as const,
            user: null
          };
        }

        throw error;
      }
    );
    return {
      action: `user_updated_${result.status}`,
      received: true
    };
  }

  return {
    action: "ignored",
    received: true
  };
};

export const handleClerkWebhook = async (input: {
  headers: RequestHeaders;
  rawBody: string;
}): Promise<{ action: string; received: true }> => {
  verifyClerkWebhookSignature(input);

  try {
    return await handleVerifiedClerkWebhook(
      clerkWebhookEventSchema.parse(JSON.parse(input.rawBody))
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new ClerkWebhookError("Clerk webhook payload is invalid.", 400);
    }

    throw error;
  }
};
