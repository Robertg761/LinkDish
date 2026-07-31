import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { extractorApiEnv } from "../../config/env.js";
import { hashAnalyticsUserId } from "../analytics/analytics-privacy.js";
import { writeAnalyticsEvents } from "../analytics/analytics-store.js";
import { getHeader, type RequestHeaders } from "../request-identity.js";

const maxTimestampSkewSeconds = 300;
const monthlyDurationMinimumMs = 20 * 24 * 60 * 60 * 1_000;
const yearlyDurationMinimumMs = 300 * 24 * 60 * 60 * 1_000;

const revenueCatWebhookSchema = z
  .object({
    api_version: z.string().min(1),
    event: z
      .object({
        app_user_id: z.string().min(1),
        entitlement_id: z.string().nullable().optional(),
        entitlement_ids: z.array(z.string()).nullable().optional(),
        environment: z.string().optional(),
        event_timestamp_ms: z.number().int().nonnegative(),
        expiration_at_ms: z.number().int().nonnegative().nullable().optional(),
        id: z.string().min(1),
        period_type: z.string().nullable().optional(),
        product_id: z.string().nullable().optional(),
        purchased_at_ms: z.number().int().nonnegative().nullable().optional(),
        store: z.string().nullable().optional(),
        type: z.string().min(1)
      })
      .passthrough()
  })
  .passthrough();

type RevenueCatWebhookEvent = z.infer<typeof revenueCatWebhookSchema>["event"];
type PurchaseBillingPeriod = "lifetime" | "monthly" | "yearly";
type PurchasePlan = "family" | "plus" | "unknown";

export class RevenueCatWebhookError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "RevenueCatWebhookError";
  }
}

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const getRequiredWebhookConfiguration = () => {
  const authorization = extractorApiEnv.REVENUECAT_WEBHOOK_AUTHORIZATION;
  const signingSecret = extractorApiEnv.REVENUECAT_WEBHOOK_SIGNING_SECRET;

  if (!authorization || !signingSecret) {
    throw new RevenueCatWebhookError("RevenueCat webhook verification is not configured.", 503);
  }

  return {
    authorization,
    signingSecret
  };
};

const verifyAuthorization = (headers: RequestHeaders, expectedAuthorization: string): void => {
  const authorization = getHeader(headers, "authorization");

  if (!authorization || !constantTimeEquals(authorization, expectedAuthorization)) {
    throw new RevenueCatWebhookError("RevenueCat webhook authorization is invalid.", 401);
  }
};

const parseSignatureHeader = (
  header: string
): { signatures: string[]; timestamp: string | null } => {
  const parts = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      return separatorIndex === -1
        ? ([part, ""] as const)
        : ([part.slice(0, separatorIndex), part.slice(separatorIndex + 1)] as const);
    });

  return {
    signatures: parts.filter(([key]) => key === "v1").map(([, value]) => value),
    timestamp: parts.find(([key]) => key === "t")?.[1] ?? null
  };
};

const verifySignature = (headers: RequestHeaders, rawBody: string, signingSecret: string): void => {
  const signatureHeader = getHeader(headers, "x-revenuecat-webhook-signature");

  if (!signatureHeader) {
    throw new RevenueCatWebhookError("RevenueCat webhook signature is missing.", 401);
  }

  const { signatures, timestamp } = parseSignatureHeader(signatureHeader);
  const timestampSeconds = Number(timestamp);

  if (
    !timestamp ||
    !Number.isInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1_000 - timestampSeconds) > maxTimestampSkewSeconds
  ) {
    throw new RevenueCatWebhookError("RevenueCat webhook timestamp is invalid.", 401);
  }

  const expectedSignature = createHmac("sha256", signingSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const matches = signatures.some(
    (signature) =>
      /^[a-f0-9]{64}$/iu.test(signature) && constantTimeEquals(signature, expectedSignature)
  );

  if (!matches) {
    throw new RevenueCatWebhookError("RevenueCat webhook signature is invalid.", 401);
  }
};

export const verifyRevenueCatWebhook = (input: {
  headers: RequestHeaders;
  rawBody: string;
}): void => {
  const configuration = getRequiredWebhookConfiguration();
  verifyAuthorization(input.headers, configuration.authorization);
  verifySignature(input.headers, input.rawBody, configuration.signingSecret);
};

const normalizeIdentifiers = (event: RevenueCatWebhookEvent): string[] =>
  [event.entitlement_id, ...(event.entitlement_ids ?? []), event.product_id]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

const getPurchasePlan = (event: RevenueCatWebhookEvent): PurchasePlan => {
  const identifiers = normalizeIdentifiers(event);
  const familyEntitlementId = extractorApiEnv.REVENUECAT_FAMILY_ENTITLEMENT_ID.toLowerCase();
  const plusEntitlementId = extractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID.toLowerCase();

  if (
    identifiers.some(
      (identifier) => identifier === familyEntitlementId || identifier.includes("family")
    )
  ) {
    return "family";
  }

  if (
    identifiers.some(
      (identifier) => identifier === plusEntitlementId || identifier.includes("plus")
    )
  ) {
    return "plus";
  }

  return "unknown";
};

const getPurchaseBillingPeriod = (
  event: RevenueCatWebhookEvent
): PurchaseBillingPeriod | undefined => {
  const productId = event.product_id?.toLowerCase() ?? "";

  if (event.type === "NON_RENEWING_PURCHASE" || productId.includes("lifetime")) {
    return "lifetime";
  }

  if (/annual|year|yearly/u.test(productId)) {
    return "yearly";
  }

  if (/month|monthly/u.test(productId)) {
    return "monthly";
  }

  if (event.purchased_at_ms != null && event.expiration_at_ms != null) {
    const durationMs = event.expiration_at_ms - event.purchased_at_ms;

    if (durationMs >= yearlyDurationMinimumMs) {
      return "yearly";
    }

    if (durationMs >= monthlyDurationMinimumMs) {
      return "monthly";
    }
  }

  return undefined;
};

const isPurchaseEvent = (event: RevenueCatWebhookEvent): boolean =>
  event.type === "INITIAL_PURCHASE" || event.type === "NON_RENEWING_PURCHASE";

const isPromotionalGrant = (event: RevenueCatWebhookEvent): boolean =>
  event.period_type?.toUpperCase() === "PROMOTIONAL" ||
  event.store?.toUpperCase() === "PROMOTIONAL";

export const handleVerifiedRevenueCatWebhook = async (
  event: RevenueCatWebhookEvent
): Promise<{ action: string; received: true }> => {
  if (event.environment && event.environment !== "PRODUCTION") {
    return {
      action: "ignored_non_production",
      received: true
    };
  }

  if (isPromotionalGrant(event)) {
    return {
      action: "ignored_promotional",
      received: true
    };
  }

  if (!isPurchaseEvent(event)) {
    return {
      action: "ignored",
      received: true
    };
  }

  const billingPeriod = getPurchaseBillingPeriod(event);
  const accepted = await writeAnalyticsEvents([
    {
      accountUserHash: hashAnalyticsUserId(event.app_user_id),
      eventName: "upgrade_purchased",
      occurredAt: new Date(event.purchased_at_ms ?? event.event_timestamp_ms).toISOString(),
      platform: "backend",
      properties: {
        ...(billingPeriod ? { billing_period: billingPeriod } : {}),
        plan: getPurchasePlan(event),
        ...(billingPeriod === "lifetime" ? { trigger: "founding" } : {})
      },
      requestId: `revenuecat:${createHash("sha256").update(event.id).digest("hex")}`,
      routeOrScreen: "/webhooks/revenuecat"
    }
  ]);

  return {
    action: accepted === 0 ? "purchase_already_recorded" : "purchase_recorded",
    received: true
  };
};

export const handleRevenueCatWebhook = async (input: {
  headers: RequestHeaders;
  rawBody: string;
}): Promise<{ action: string; received: true }> => {
  verifyRevenueCatWebhook(input);

  try {
    const payload = revenueCatWebhookSchema.parse(JSON.parse(input.rawBody));
    return await handleVerifiedRevenueCatWebhook(payload.event);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RevenueCatWebhookError("RevenueCat webhook payload is invalid.", 400);
    }

    throw error;
  }
};
