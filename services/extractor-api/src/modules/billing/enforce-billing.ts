import { createHash, timingSafeEqual } from "node:crypto";

import { extractorApiEnv } from "../../config/env.js";
import { getAuthenticatedUser } from "../auth/auth-service.js";
import { getActiveHouseholdQuotaForUser } from "../households/household-service.js";
import {
  getHeader,
  getRequestAddress,
  hashServerSideIdentity,
  type RequestHeaders,
  type RequestIdentity
} from "../request-identity.js";

import { getRevenueCatBillingPlanId } from "./revenuecat-entitlements.js";

import type {
  ExtractRecipeFailure,
  ExtractRecipeResponse,
  QuotaMeteringMode,
  QuotaStatus
} from "../../../../../packages/api-contracts/src/index.js";

type BillingPlanId = "free" | "plus" | "family";
type QuotaKind = "imports" | "strongExtractions";

interface QuotaPlan {
  id: BillingPlanId;
  monthlyImports: number;
  monthlyStrongExtractions: number;
}

interface BillingAuthorizationResult {
  allowed: boolean;
  response?: ExtractRecipeResponse;
  commitUsage: (
    response: ExtractRecipeResponse
  ) => Promise<BillingAuthorizationResult["logContext"]>;
  logContext: {
    billingClientId: string | null;
    accountUserId: string | null;
    billingEnabled: boolean;
    billingQuotaIdentity: "client" | "disabled" | "household" | "network" | "unknown";
    billingPlan: BillingPlanId | "disabled" | "unknown";
    householdId: string | null;
    householdRole: "member" | "owner" | null;
    meteringMode: QuotaMeteringMode;
    quotaCount: number | null;
    quotaKind: QuotaKind | null;
    quotaLimit: number | null;
  };
}

interface UpstashResponse {
  error?: string;
  result?: unknown;
}

interface QuotaUsageEntry {
  meteringMode: QuotaMeteringMode;
  quota: QuotaStatus;
  quotaCount: number;
  quotaKind: QuotaKind;
  quotaLimit: number;
}

const inMemoryQuotaCounts = new Map<string, number>();
const quotaAccountingVersion = "v4";

const freePlan = (): QuotaPlan => ({
  id: "free",
  monthlyImports: extractorApiEnv.FREE_LIFETIME_IMPORT_LIMIT,
  monthlyStrongExtractions: extractorApiEnv.FREE_LIFETIME_IMPORT_LIMIT
});

const plusPlan = (): QuotaPlan => ({
  id: "plus",
  monthlyImports: extractorApiEnv.PLUS_MONTHLY_IMPORT_LIMIT,
  monthlyStrongExtractions: extractorApiEnv.PLUS_MONTHLY_IMPORT_LIMIT
});

const familyPlan = (): QuotaPlan => ({
  id: "family",
  monthlyImports: extractorApiEnv.FAMILY_MONTHLY_IMPORT_LIMIT,
  monthlyStrongExtractions: extractorApiEnv.FAMILY_MONTHLY_IMPORT_LIMIT
});

const getCurrentPeriodKey = (date = new Date()): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const getSecondsUntilNextPeriod = (date = new Date()): number => {
  const nextPeriod = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return Math.ceil((nextPeriod.getTime() - date.getTime()) / 1000) + 86_400;
};

const getNextPeriodStartIso = (date = new Date()): string =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();

const failureResponse = (
  userMessage: string,
  quota?: ExtractRecipeFailure["quota"]
): ExtractRecipeResponse => ({
  status: "failure",
  reason: "plan_limit",
  userMessage,
  recovery: {
    retryable: true,
    allowFallback: false,
    suggestedAction: "try_again_later"
  },
  ...(quota ? { quota } : {})
});

const getClientId = (headers: RequestHeaders): string | null =>
  getHeader(headers, "x-linkdish-client-id");

const hashQuotaIdentity = (value: string): string =>
  hashServerSideIdentity("quota-identity", value);

const getQuotaIdentity = (
  plan: QuotaPlan,
  clientId: string,
  headers: RequestHeaders,
  identity?: RequestIdentity,
  householdId?: string | null
): {
  billingQuotaIdentity: BillingAuthorizationResult["logContext"]["billingQuotaIdentity"];
  quotaIdentityKey: string;
} => {
  if (plan.id === "family" && householdId) {
    return {
      billingQuotaIdentity: "household",
      quotaIdentityKey: `household:${householdId}`
    };
  }

  if (plan.id !== "free") {
    return {
      billingQuotaIdentity: "client",
      quotaIdentityKey: `client:${clientId}`
    };
  }

  return {
    billingQuotaIdentity: "network",
    quotaIdentityKey: `network:${hashQuotaIdentity(getRequestAddress(headers, identity))}`
  };
};

const getQuotaPlan = async (clientId: string, allowPaidPlan: boolean): Promise<QuotaPlan> => {
  if (!allowPaidPlan) {
    return freePlan();
  }

  const planId = await getRevenueCatBillingPlanId(clientId);

  if (planId === "family") {
    return familyPlan();
  }

  if (planId === "plus") {
    return plusPlan();
  }

  return freePlan();
};

const getQuotaLimit = (plan: QuotaPlan, quotaKind: QuotaKind): number =>
  quotaKind === "imports" ? plan.monthlyImports : plan.monthlyStrongExtractions;

const getQuotaFailureMessage = (plan: QuotaPlan, quotaKind: QuotaKind): string => {
  if (quotaKind === "strongExtractions") {
    return plan.id === "free"
      ? "You have used your free recipe allowance. LinkDish Plus and Family include more recipe imports."
      : `You have used this month's ${plan.id === "family" ? "LinkDish Family" : "LinkDish Plus"} recipe allowance.`;
  }

  if (plan.id === "free") {
    return "You have used your free recipe allowance. LinkDish Plus and Family include more recipe imports.";
  }

  return `You have used this month's ${plan.id === "family" ? "LinkDish Family" : "LinkDish Plus"} recipe allowance.`;
};

const incrementWithUpstash = async (key: string, ttlSeconds?: number): Promise<number> => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis REST is not configured.");
  }

  const commands: unknown[][] = [["INCR", key]];

  if (ttlSeconds != null) {
    commands.push(["EXPIRE", key, String(ttlSeconds), "NX"]);
  }

  const response = await fetch(`${extractorApiEnv.UPSTASH_REDIS_REST_URL}/multi-exec`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  if (!response.ok) {
    throw new Error(`Upstash quota increment failed with ${response.status}.`);
  }

  const body = (await response.json()) as UpstashResponse[];
  const incrementResult = body[0];

  if (incrementResult?.error) {
    throw new Error(incrementResult.error);
  }

  if (typeof incrementResult?.result !== "number") {
    throw new Error("Upstash quota increment returned an invalid response.");
  }

  return incrementResult.result;
};

const readWithUpstash = async (key: string): Promise<number> => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis REST is not configured.");
  }

  const response = await fetch(
    `${extractorApiEnv.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
    {
      headers: {
        authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Upstash quota read failed with ${response.status}.`);
  }

  const body = (await response.json()) as UpstashResponse;

  if (body.error) {
    throw new Error(body.error);
  }

  if (body.result == null) {
    return 0;
  }

  const parsedValue = Number(body.result);

  if (!Number.isFinite(parsedValue)) {
    throw new Error("Upstash quota read returned an invalid response.");
  }

  return Math.max(0, Math.floor(parsedValue));
};

const incrementInMemory = (key: string): number => {
  const nextValue = (inMemoryQuotaCounts.get(key) ?? 0) + 1;
  inMemoryQuotaCounts.set(key, nextValue);
  return nextValue;
};

const getMonthlyUsageKey = (quotaIdentityKey: string, quotaKind: QuotaKind): string =>
  `linkdish:quota:${quotaAccountingVersion}:${getCurrentPeriodKey()}:${quotaKind}:${quotaIdentityKey}`;

const getLifetimeUsageKey = (quotaIdentityKey: string, quotaKind: QuotaKind): string =>
  `linkdish:quota:${quotaAccountingVersion}:lifetime:${quotaKind}:${quotaIdentityKey}`;

const getUsageKey = (plan: QuotaPlan, quotaIdentityKey: string, quotaKind: QuotaKind): string =>
  plan.id === "free"
    ? getLifetimeUsageKey(quotaIdentityKey, quotaKind)
    : getMonthlyUsageKey(quotaIdentityKey, quotaKind);

const readInMemory = (key: string): number => inMemoryQuotaCounts.get(key) ?? 0;

const getRemaining = (limit: number, count: number): number => Math.max(0, limit - count);

const buildQuotaStatus = ({
  limit,
  remaining,
  monthlyLimit,
  remainingThisMonth,
  meteringMode
}: {
  limit: number;
  remaining: number;
  monthlyLimit: number | null;
  remainingThisMonth: number | null;
  meteringMode: QuotaMeteringMode;
}): QuotaStatus => ({
  limit,
  remaining,
  monthlyLimit,
  remainingThisMonth,
  resetsAt: monthlyLimit == null ? null : getNextPeriodStartIso(),
  meteringMode
});

const readUsageKey = async (key: string): Promise<number> => {
  if (extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    return readWithUpstash(key);
  }

  return readInMemory(key);
};

const incrementUsageKey = async (key: string, ttlSeconds?: number): Promise<number> => {
  if (extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    return incrementWithUpstash(key, ttlSeconds);
  }

  return incrementInMemory(key);
};

const readUsage = async (
  plan: QuotaPlan,
  quotaIdentityKey: string,
  quotaKind: QuotaKind
): Promise<QuotaUsageEntry> => {
  if (plan.id === "free" && extractorApiEnv.LINKDISH_MONTHLY_METERING) {
    const lifetimeKey = getLifetimeUsageKey(quotaIdentityKey, quotaKind);
    const monthlyKey = getMonthlyUsageKey(quotaIdentityKey, quotaKind);
    const [lifetimeCount, monthlyCount] = await Promise.all([
      readUsageKey(lifetimeKey),
      readUsageKey(monthlyKey)
    ]);
    const lifetimeLimit = extractorApiEnv.FREE_LIFETIME_IMPORT_LIMIT;
    const monthlyLimit = extractorApiEnv.FREE_MONTHLY_IMPORT_LIMIT;
    const lifetimeRemaining = getRemaining(lifetimeLimit, lifetimeCount);
    const monthlyRemaining = getRemaining(monthlyLimit, monthlyCount);
    const monthlyIsBetter = monthlyRemaining >= lifetimeRemaining;
    const quotaLimit = monthlyIsBetter ? monthlyLimit : lifetimeLimit;
    const quotaCount = monthlyIsBetter ? monthlyCount : lifetimeCount;
    const remaining = Math.max(lifetimeRemaining, monthlyRemaining);
    const meteringMode = "free_monthly_grandfathered" as const;

    return {
      meteringMode,
      quotaKind,
      quotaCount,
      quotaLimit,
      quota: buildQuotaStatus({
        limit: quotaLimit,
        remaining,
        monthlyLimit,
        remainingThisMonth: monthlyRemaining,
        meteringMode
      })
    };
  }

  const key = getUsageKey(plan, quotaIdentityKey, quotaKind);
  const quotaCount = await readUsageKey(key);
  const quotaLimit = getQuotaLimit(plan, quotaKind);
  const remaining = getRemaining(quotaLimit, quotaCount);
  const meteringMode = plan.id === "free" ? "free_lifetime" : "paid_monthly";
  const monthlyLimit = plan.id === "free" ? null : quotaLimit;
  const remainingThisMonth = plan.id === "free" ? null : remaining;

  return {
    meteringMode,
    quotaKind,
    quotaCount,
    quotaLimit,
    quota: buildQuotaStatus({
      limit: quotaLimit,
      remaining,
      monthlyLimit,
      remainingThisMonth,
      meteringMode
    })
  };
};

const incrementUsage = async (
  plan: QuotaPlan,
  quotaIdentityKey: string,
  quotaKind: QuotaKind
): Promise<QuotaUsageEntry> => {
  if (plan.id === "free" && extractorApiEnv.LINKDISH_MONTHLY_METERING) {
    await Promise.all([
      incrementUsageKey(getLifetimeUsageKey(quotaIdentityKey, quotaKind)),
      incrementUsageKey(getMonthlyUsageKey(quotaIdentityKey, quotaKind), getSecondsUntilNextPeriod())
    ]);
    return readUsage(plan, quotaIdentityKey, quotaKind);
  }

  const key = getUsageKey(plan, quotaIdentityKey, quotaKind);

  await incrementUsageKey(key, plan.id === "free" ? undefined : getSecondsUntilNextPeriod());
  return readUsage(plan, quotaIdentityKey, quotaKind);
};

const getRequiredQuotaKinds = (attempt: "primary" | "fallback"): QuotaKind[] =>
  attempt === "fallback" ? ["imports", "strongExtractions"] : ["imports"];

const getPrimaryQuotaKind = (attempt: "primary" | "fallback"): QuotaKind =>
  attempt === "fallback" ? "strongExtractions" : "imports";

const noopCommitUsage = (
  _response: ExtractRecipeResponse,
  logContext: BillingAuthorizationResult["logContext"]
) => Promise.resolve(logContext);

const isAuthorizedCanaryRequest = (headers: RequestHeaders): boolean => {
  const canaryToken = extractorApiEnv.LINKDISH_CANARY_TOKEN?.trim();

  if (!canaryToken) {
    return false;
  }

  const authorization = getHeader(headers, "authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const presentedToken = authorization.slice("Bearer ".length).trim();

  if (!presentedToken) {
    return false;
  }

  return timingSafeEqual(
    createHash("sha256").update(canaryToken).digest(),
    createHash("sha256").update(presentedToken).digest()
  );
};

export const authorizeExtractionRequest = async (
  headers: RequestHeaders,
  attempt: "primary" | "fallback",
  identity?: RequestIdentity
): Promise<BillingAuthorizationResult> => {
  if (!extractorApiEnv.BILLING_ENFORCEMENT_ENABLED) {
    const logContext = {
      accountUserId: null,
      billingClientId: null,
      billingEnabled: false,
      billingQuotaIdentity: "disabled" as const,
      billingPlan: "disabled" as const,
      householdId: null,
      householdRole: null,
      meteringMode: "disabled" as const,
      quotaCount: null,
      quotaKind: null,
      quotaLimit: null
    };

    return {
      allowed: true,
      commitUsage: (response) => noopCommitUsage(response, logContext),
      logContext
    };
  }

  if (isAuthorizedCanaryRequest(headers)) {
    const logContext = {
      accountUserId: null,
      billingClientId: "live-canary",
      billingEnabled: true,
      billingQuotaIdentity: "client" as const,
      billingPlan: "plus" as const,
      householdId: null,
      householdRole: null,
      meteringMode: "disabled" as const,
      quotaCount: null,
      quotaKind: getPrimaryQuotaKind(attempt),
      quotaLimit: null
    };

    return {
      allowed: true,
      commitUsage: (response) => noopCommitUsage(response, logContext),
      logContext
    };
  }

  const clientId = getClientId(headers);
  const quotaKind = getPrimaryQuotaKind(attempt);
  const authenticatedSession = extractorApiEnv.HOUSEHOLDS_ENABLED
    ? await getAuthenticatedUser(headers).catch(() => null)
    : null;
  const billingClientId = authenticatedSession?.user.id ?? clientId;

  if (!billingClientId) {
    const logContext = {
      accountUserId: null,
      billingClientId: null,
      billingEnabled: true,
      billingQuotaIdentity: "unknown" as const,
      billingPlan: "unknown" as const,
      householdId: null,
      householdRole: null,
      meteringMode: "unknown" as const,
      quotaCount: null,
      quotaKind,
      quotaLimit: null
    };

    return {
      allowed: false,
      response: failureResponse(
        "LinkDish could not identify this app install. Please reopen the app and try again."
      ),
      commitUsage: (response) => noopCommitUsage(response, logContext),
      logContext
    };
  }

  try {
    const activeHouseholdQuota = authenticatedSession
      ? await getActiveHouseholdQuotaForUser(authenticatedSession.user.id)
      : null;
    const plan = activeHouseholdQuota
      ? familyPlan()
      : await getQuotaPlan(billingClientId, Boolean(authenticatedSession));
    const { billingQuotaIdentity, quotaIdentityKey } = getQuotaIdentity(
      plan,
      billingClientId,
      headers,
      identity,
      activeHouseholdQuota?.householdId ?? null
    );
    const requiredQuotaKinds = getRequiredQuotaKinds(attempt);
    const usageEntries = await Promise.all(
      requiredQuotaKinds.map((requiredQuotaKind) =>
        readUsage(plan, quotaIdentityKey, requiredQuotaKind)
      )
    );
    const blockedQuota = usageEntries.find((entry) => entry.quotaCount >= entry.quotaLimit);
    const primaryUsage =
      usageEntries.find((entry) => entry.quotaKind === quotaKind) ?? usageEntries[0];

    if (blockedQuota) {
      const logContext = {
        accountUserId: authenticatedSession?.user.id ?? null,
        billingClientId,
        billingEnabled: true,
        billingQuotaIdentity,
        billingPlan: plan.id,
        householdId: activeHouseholdQuota?.householdId ?? null,
        householdRole: activeHouseholdQuota?.role ?? null,
        meteringMode: blockedQuota.meteringMode,
        quotaCount: blockedQuota.quotaCount,
        quotaKind: blockedQuota.quotaKind,
        quotaLimit: blockedQuota.quotaLimit
      };

      return {
        allowed: false,
        response: failureResponse(
          getQuotaFailureMessage(plan, blockedQuota.quotaKind),
          blockedQuota.quota
        ),
        commitUsage: (response) => noopCommitUsage(response, logContext),
        logContext
      };
    }

    const logContext = {
      accountUserId: authenticatedSession?.user.id ?? null,
      billingClientId,
      billingEnabled: true,
      billingQuotaIdentity,
      billingPlan: plan.id,
      householdId: activeHouseholdQuota?.householdId ?? null,
      householdRole: activeHouseholdQuota?.role ?? null,
      meteringMode: primaryUsage?.meteringMode ?? "unknown",
      quotaCount: primaryUsage?.quotaCount ?? 0,
      quotaKind,
      quotaLimit: primaryUsage?.quotaLimit ?? getQuotaLimit(plan, quotaKind)
    };

    return {
      allowed: true,
      commitUsage: async (response) => {
        if (response.status !== "success") {
          return logContext;
        }

        const committedEntries = await Promise.all(
          requiredQuotaKinds.map((requiredQuotaKind) =>
            incrementUsage(plan, quotaIdentityKey, requiredQuotaKind)
          )
        );
        const committedPrimaryUsage =
          committedEntries.find((entry) => entry.quotaKind === quotaKind) ?? committedEntries[0];

        return {
          ...logContext,
          meteringMode: committedPrimaryUsage?.meteringMode ?? logContext.meteringMode,
          quotaCount: committedPrimaryUsage?.quotaCount ?? logContext.quotaCount,
          quotaLimit: committedPrimaryUsage?.quotaLimit ?? logContext.quotaLimit
        };
      },
      logContext
    };
  } catch (error) {
    console.error(error);
    const logContext = {
      accountUserId: authenticatedSession?.user.id ?? null,
      billingClientId,
      billingEnabled: true,
      billingQuotaIdentity: "unknown" as const,
      billingPlan: "unknown" as const,
      householdId: null,
      householdRole: null,
      meteringMode: "unknown" as const,
      quotaCount: null,
      quotaKind,
      quotaLimit: null
    };

    return {
      allowed: false,
      response: failureResponse(
        "LinkDish could not verify your recipe allowance right now. Please try again in a moment."
      ),
      commitUsage: (response) => noopCommitUsage(response, logContext),
      logContext
    };
  }
};
