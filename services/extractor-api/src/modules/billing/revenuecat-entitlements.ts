import { extractorApiEnv } from "../../config/env.js";
import { hashServerSideIdentity } from "../request-identity.js";
import {
  getStoreString,
  runStoreCommand,
  runStoreTransaction,
  setStoreStringUnlessBlocked
} from "../storage/upstash-store.js";

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

  /* An admin grant changes the plan immediately; do not serve the old cached one. */
  await invalidateRevenueCatEntitlementCache(appUserId);

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

/*
 * Entitlement cache. Every import and every household request used to make one
 * or two uncached RevenueCat calls (hundreds of milliseconds each). Paid plans
 * ("plus"/"family") are cached per user for 5 minutes; "free" is never cached,
 * so a purchase is picked up on the very next request, and any cached value
 * that would grant access is dropped by the RevenueCat webhook (every
 * verified event for the user) or overwritten by the next fresh lookup.
 * Cache failures only ever fall back to RevenueCat.
 *
 * A lookup that was already waiting on RevenueCat when the webhook arrived may
 * hold the pre-change answer, so the invalidation also leaves a marker for one
 * cache lifetime, and a paid plan is only written while no marker exists (one
 * atomic EVAL) and when the lookup started less than a cache lifetime ago.
 * For those 5 minutes the user's plan is read from RevenueCat on every request.
 */
export const REVENUECAT_ENTITLEMENT_CACHE_TTL_SECONDS = 5 * 60;
const entitlementCacheTimeoutMs = 1_000;

export const getRevenueCatEntitlementCacheKey = (appUserId: string): string =>
  `linkdish:entitlement:v1:${hashServerSideIdentity("entitlement-cache", appUserId)}`;

const getRevenueCatEntitlementInvalidationKey = (appUserId: string): string =>
  `linkdish:entitlement-invalidated:v1:${hashServerSideIdentity("entitlement-cache", appUserId)}`;

type PaidPlanId = Exclude<RevenueCatBillingPlanId, "free">;

const isPaidPlanId = (value: unknown): value is PaidPlanId =>
  value === "plus" || value === "family";

const readCachedPaidPlanId = async (appUserId: string): Promise<PaidPlanId | null> => {
  try {
    const cachedValue = await getStoreString(getRevenueCatEntitlementCacheKey(appUserId), {
      timeoutMs: entitlementCacheTimeoutMs
    });
    return isPaidPlanId(cachedValue) ? cachedValue : null;
  } catch {
    return null;
  }
};

const writeCachedPlanId = async (
  appUserId: string,
  planId: RevenueCatBillingPlanId,
  lookupStartedAtMs: number
): Promise<void> => {
  try {
    if (isPaidPlanId(planId)) {
      /* An invalidation marker from before this lookup began may already have expired. */
      if (Date.now() - lookupStartedAtMs >= REVENUECAT_ENTITLEMENT_CACHE_TTL_SECONDS * 1_000) {
        return;
      }

      await setStoreStringUnlessBlocked(
        getRevenueCatEntitlementCacheKey(appUserId),
        planId,
        getRevenueCatEntitlementInvalidationKey(appUserId),
        {
          timeoutMs: entitlementCacheTimeoutMs,
          ttlSeconds: REVENUECAT_ENTITLEMENT_CACHE_TTL_SECONDS
        }
      );
      return;
    }

    await runStoreCommand(["DEL", getRevenueCatEntitlementCacheKey(appUserId)], {
      timeoutMs: entitlementCacheTimeoutMs
    });
  } catch {
    /* The cache is an optimisation; RevenueCat stays the source of truth. */
  }
};

/* Concurrent lookups for one user in one instance share a single RevenueCat call. */
const inflightPlanLookups = new Map<string, Promise<RevenueCatBillingPlanId>>();

const lookupRevenueCatBillingPlanId = (appUserId: string): Promise<RevenueCatBillingPlanId> => {
  const inflightLookup = inflightPlanLookups.get(appUserId);

  if (inflightLookup) {
    return inflightLookup;
  }

  const startedAtMs = Date.now();
  const lookup = getRevenueCatSubscriber(appUserId)
    .then(async (subscriber) => {
      const planId = getRevenueCatBillingPlanIdFromSubscriber(subscriber);
      await writeCachedPlanId(appUserId, planId, startedAtMs);
      return planId;
    })
    .finally(() => {
      inflightPlanLookups.delete(appUserId);
    });

  inflightPlanLookups.set(appUserId, lookup);
  return lookup;
};

/**
 * A fresh RevenueCat lookup (it also refreshes the cache). Used where a stale
 * answer would be visible or would authorise a change: account and billing
 * screens, household creation, invites and member management.
 */
export const getRevenueCatBillingPlanId = async (
  appUserId: string
): Promise<RevenueCatBillingPlanId> => {
  const testPremiumPlanId = getTestPremiumBillingPlanId(appUserId);

  if (testPremiumPlanId) {
    return testPremiumPlanId;
  }

  return lookupRevenueCatBillingPlanId(appUserId);
};

/** The test-premium or cached paid plan, without calling RevenueCat. */
export const peekCachedRevenueCatBillingPlanId = async (
  appUserId: string
): Promise<PaidPlanId | null> =>
  getTestPremiumBillingPlanId(appUserId) ?? (await readCachedPaidPlanId(appUserId));

/** Hot-path lookup (imports, household reads): a cached paid plan, else RevenueCat. */
export const getCachedRevenueCatBillingPlanId = async (
  appUserId: string
): Promise<RevenueCatBillingPlanId> =>
  (await peekCachedRevenueCatBillingPlanId(appUserId)) ?? lookupRevenueCatBillingPlanId(appUserId);

/** Cached check for household reads (quota, shared recipes, shopping list, summary). */
export const hasActiveRevenueCatFamilyEntitlement = async (appUserId: string): Promise<boolean> =>
  (await getCachedRevenueCatBillingPlanId(appUserId)) === "family";

/** Fresh check for household changes that require an active Family subscription. */
export const verifyActiveRevenueCatFamilyEntitlement = async (
  appUserId: string
): Promise<boolean> => (await getRevenueCatBillingPlanId(appUserId)) === "family";

export const invalidateRevenueCatEntitlementCache = async (
  ...appUserIds: Array<string | null | undefined>
): Promise<void> => {
  const users = [
    ...new Set(appUserIds.filter((appUserId): appUserId is string => Boolean(appUserId?.trim())))
  ];

  if (users.length === 0) {
    return;
  }

  try {
    /* The marker stops lookups already in flight from writing their pre-change answer back. */
    const results = await runStoreTransaction(
      [
        ["DEL", ...users.map(getRevenueCatEntitlementCacheKey)],
        ...users.map((appUserId) => [
          "SET",
          getRevenueCatEntitlementInvalidationKey(appUserId),
          "1",
          "EX",
          String(REVENUECAT_ENTITLEMENT_CACHE_TTL_SECONDS)
        ])
      ],
      { timeoutMs: entitlementCacheTimeoutMs }
    );
    const failed = results.find((result) => result.error);

    if (failed?.error) {
      throw new Error(failed.error);
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "revenuecat_entitlement_cache_invalidation_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
};
