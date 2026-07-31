import { extractorApiEnv } from "../../config/env.js";

export type RevenueCatBillingPlanId = "free" | "plus" | "family";

export interface RevenueCatSubscriber {
  entitlements?: Record<
    string,
    {
      expires_date?: string | null;
      product_identifier?: string | null;
      purchase_date?: string | null;
    }
  >;
  first_seen?: string | null;
  last_seen?: string | null;
  management_url?: string | null;
  non_subscriptions?: Record<
    string,
    Array<{
      id?: string | null;
      is_sandbox?: boolean | null;
      purchase_date?: string | null;
      store?: string | null;
    }>
  >;
  original_app_user_id?: string | null;
  subscriptions?: Record<
    string,
    {
      billing_issues_detected_at?: string | null;
      expires_date?: string | null;
      ownership_type?: string | null;
      period_type?: string | null;
      purchase_date?: string | null;
      store?: string | null;
      unsubscribe_detected_at?: string | null;
    }
  >;
}

interface RevenueCatSubscriberResponse {
  subscriber?: RevenueCatSubscriber;
}

export class RevenueCatApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "RevenueCatApiError";
  }
}

const getRevenueCatSecretApiKey = (): string => {
  if (!extractorApiEnv.REVENUECAT_SECRET_API_KEY) {
    throw new Error("Billing enforcement requires REVENUECAT_SECRET_API_KEY.");
  }

  return extractorApiEnv.REVENUECAT_SECRET_API_KEY;
};

const readRevenueCatResponse = async <Value>(response: Response): Promise<Value> => {
  const responseText = await response.text();

  if (!response.ok) {
    throw new RevenueCatApiError(
      `RevenueCat request failed with ${response.status}.`,
      response.status,
      responseText
    );
  }

  return JSON.parse(responseText) as Value;
};

export const getRevenueCatSubscriber = async (appUserId: string): Promise<RevenueCatSubscriber> => {
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${getRevenueCatSecretApiKey()}`
      }
    }
  );
  const body = await readRevenueCatResponse<RevenueCatSubscriberResponse>(response);

  return body.subscriber ?? {};
};

export const isRevenueCatEntitlementActive = (
  subscriber: RevenueCatSubscriber,
  entitlementId: string
): boolean => {
  const entitlement = subscriber.entitlements?.[entitlementId];

  if (!entitlement) {
    return false;
  }

  if (entitlement.expires_date == null) {
    return true;
  }

  return Date.parse(entitlement.expires_date) > Date.now();
};

const getTestPremiumUserIds = (): Set<string> =>
  new Set(
    (extractorApiEnv.LINKDISH_TEST_PREMIUM_USER_IDS ?? "")
      .split(/[,\s]+/u)
      .map((userId) => userId.trim())
      .filter(Boolean)
  );

export const getTestPremiumBillingPlanId = (
  appUserId: string
): Exclude<RevenueCatBillingPlanId, "free"> | null =>
  getTestPremiumUserIds().has(appUserId) ? extractorApiEnv.LINKDISH_TEST_PREMIUM_PLAN_ID : null;

export const getRevenueCatEntitlementIdForPlan = (
  planId: Exclude<RevenueCatBillingPlanId, "free">
): string =>
  planId === "family"
    ? extractorApiEnv.REVENUECAT_FAMILY_ENTITLEMENT_ID
    : (extractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID ?? extractorApiEnv.REVENUECAT_ENTITLEMENT_ID);

export const grantRevenueCatPromotionalEntitlement = async ({
  appUserId,
  endTimeMs,
  entitlementId
}: {
  appUserId: string;
  endTimeMs: number;
  entitlementId: string;
}): Promise<RevenueCatSubscriber> => {
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}/entitlements/${encodeURIComponent(entitlementId)}/promotional`,
    {
      body: JSON.stringify({
        end_time_ms: endTimeMs
      }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${getRevenueCatSecretApiKey()}`,
        "content-type": "application/json"
      },
      method: "POST"
    }
  );
  const body = await readRevenueCatResponse<RevenueCatSubscriberResponse>(response);

  return body.subscriber ?? {};
};

export const getRevenueCatBillingPlanIdFromSubscriber = (
  subscriber: RevenueCatSubscriber
): RevenueCatBillingPlanId => {
  if (isRevenueCatEntitlementActive(subscriber, extractorApiEnv.REVENUECAT_FAMILY_ENTITLEMENT_ID)) {
    return "family";
  }

  if (isRevenueCatEntitlementActive(subscriber, extractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID)) {
    return "plus";
  }

  return "free";
};

export const getRevenueCatBillingPlanId = async (
  appUserId: string
): Promise<RevenueCatBillingPlanId> => {
  const testPremiumPlanId = getTestPremiumBillingPlanId(appUserId);

  if (testPremiumPlanId) {
    return testPremiumPlanId;
  }

  const subscriber = await getRevenueCatSubscriber(appUserId);

  return getRevenueCatBillingPlanIdFromSubscriber(subscriber);
};

export const hasActiveRevenueCatFamilyEntitlement = async (appUserId: string): Promise<boolean> =>
  (await getRevenueCatBillingPlanId(appUserId)) === "family";
