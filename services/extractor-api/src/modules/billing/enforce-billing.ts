import { randomUUID } from "node:crypto";

import { extractorApiEnv } from "../../config/env.js";
import { getAuthenticatedUser } from "../auth/auth-service.js";
import { createBoundedExpiringMap } from "../bounded-expiring-map.js";
import { getActiveHouseholdQuotaForUser } from "../households/household-service.js";
import {
  getHeader,
  getRequestAddress,
  hashServerSideIdentity,
  isAuthorizedCanaryRequest,
  type RequestHeaders,
  type RequestIdentity
} from "../request-identity.js";

import {
  getRevenueCatBillingPlanId,
  peekCachedRevenueCatBillingPlanId
} from "./revenuecat-entitlements.js";

import type {
  BillingUsageResponse,
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

interface CommittedUsage {
  logContext: BillingAuthorizationResult["logContext"];
  /** The caller's allowance after this import was counted; null when nothing is metered. */
  quota: QuotaStatus | null;
}

interface BillingAuthorizationResult {
  allowed: boolean;
  response?: ExtractRecipeResponse;
  /**
   * Gives back the allowance reserved for this request when it ends without a response to commit
   * (the extraction threw). commitUsage already does this for a response that isn't a success.
   * Optional so test doubles of the authorization keep working.
   */
  releaseUsage?: () => Promise<void>;
  commitUsage: (
    response: ExtractRecipeResponse
  ) => Promise<BillingAuthorizationResult["logContext"]>;
  /**
   * commitUsage plus the committed quota, so a success response can tell the client how many
   * imports are left. Optional so test doubles of the authorization keep working.
   */
  commitUsageWithQuota?: (response: ExtractRecipeResponse) => Promise<CommittedUsage>;
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

const maxInMemoryQuotaEntries = 10_000;
const inMemoryQuotaCounts = createBoundedExpiringMap<number>({
  maxEntries: maxInMemoryQuotaEntries
});
const quotaAccountingVersion = "v4";

/* Exposed for tests and diagnostics: the fallback store must stay bounded. */
export const getInMemoryQuotaEntryCount = (): number => inMemoryQuotaCounts.size();

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

const getQuotaPlan = async (
  clientId: string,
  allowPaidPlan: boolean,
  cachedPlanId: "plus" | "family" | null = null
): Promise<QuotaPlan> => {
  if (!allowPaidPlan) {
    return freePlan();
  }

  const planId = cachedPlanId ?? (await getRevenueCatBillingPlanId(clientId));

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

/*
 * Admission is a reservation: the allowance a request needs is counted, atomically, before the
 * extraction starts, and given back if it doesn't succeed. Reading the counts and counting only
 * after a success let parallel requests with one import left all pass the check (and all count).
 *
 * Each quota kind the request needs is a gate, open while any of its counters is under its
 * limit (a grandfathered free account has a lifetime and a monthly counter, and may use either);
 * the reservation passes only when every gate is open, and then counts every counter, as a
 * committed import always has.
 */
interface QuotaCounter {
  key: string;
  limit: number;
  /** Expiry for a new counter (a monthly one ends with its month); null never expires. */
  ttlSeconds: number | null;
}

type QuotaGate = QuotaCounter[];

const getQuotaGate = (
  plan: QuotaPlan,
  quotaIdentityKey: string,
  quotaKind: QuotaKind
): QuotaGate => {
  if (plan.id === "free" && extractorApiEnv.LINKDISH_MONTHLY_METERING) {
    return [
      {
        key: getLifetimeUsageKey(quotaIdentityKey, quotaKind),
        limit: extractorApiEnv.FREE_LIFETIME_IMPORT_LIMIT,
        ttlSeconds: null
      },
      {
        key: getMonthlyUsageKey(quotaIdentityKey, quotaKind),
        limit: extractorApiEnv.FREE_MONTHLY_IMPORT_LIMIT,
        ttlSeconds: getSecondsUntilNextPeriod()
      }
    ];
  }

  return [
    {
      key: getUsageKey(plan, quotaIdentityKey, quotaKind),
      limit: getQuotaLimit(plan, quotaKind),
      ttlSeconds: plan.id === "free" ? null : getSecondsUntilNextPeriod()
    }
  ];
};

/*
 * KEYS: the reservation's token key, then every counter, gate by gate. ARGV: the token's expiry,
 * the gate count, then per gate its counter count and, per counter, its limit and expiry (0:
 * none). Returns 1, counts every counter and records the token when every gate has a counter
 * under its limit; otherwise returns 0 and counts nothing.
 */
const reserveQuotaScript = `-- linkdish_reserve_quota_v2
local argi = 3
local keyi = 2
local counters = {}
for gate = 1, tonumber(ARGV[2]) do
  local count = tonumber(ARGV[argi])
  argi = argi + 1
  local open = false
  for counter = 1, count do
    local key = KEYS[keyi]
    local limit = tonumber(ARGV[argi])
    local ttl = tonumber(ARGV[argi + 1])
    keyi = keyi + 1
    argi = argi + 2
    table.insert(counters, { key, ttl })
    if (tonumber(redis.call('GET', key)) or 0) < limit then
      open = true
    end
  end
  if not open then
    return 0
  end
end
for _, counter in ipairs(counters) do
  redis.call('INCR', counter[1])
  if counter[2] > 0 then
    redis.call('EXPIRE', counter[1], counter[2], 'NX')
  end
end
redis.call('SET', KEYS[1], '1', 'EX', tonumber(ARGV[1]))
return 1`;

/*
 * KEYS: the reservation's token key, then its counters. Gives back one count on each counter
 * (never below zero, never recreating an expired one), once: only while the token is there, and
 * it goes with the first release, so a retry after a release whose answer was lost does nothing.
 */
const releaseQuotaScript = `-- linkdish_release_quota_v2
if redis.call('DEL', KEYS[1]) == 0 then
  return 0
end
for i = 2, #KEYS do
  local value = tonumber(redis.call('GET', KEYS[i]))
  if value and value > 0 then
    redis.call('DECR', KEYS[i])
  end
end
return 1`;

/** How long a reservation can be given back: far longer than any extraction runs. */
const QUOTA_RESERVATION_TTL_SECONDS = 60 * 60;

/** A reservation: the gates it counted, and (in Upstash) the token that lets it go back once. */
interface QuotaReservation {
  gates: QuotaGate[];
  tokenKey: string;
}

const evalWithUpstash = async (
  script: string,
  keys: string[],
  args: string[]
): Promise<unknown> => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("Upstash Redis REST is not configured.");
  }

  const response = await fetch(extractorApiEnv.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(["EVAL", script, String(keys.length), ...keys, ...args])
  });

  if (!response.ok) {
    throw new Error(`Upstash quota script failed with ${response.status}.`);
  }

  const body = (await response.json()) as UpstashResponse;

  if (body.error) {
    throw new Error(body.error);
  }

  return body.result;
};

/* The in-process equivalent of reserveQuotaScript (one process: nothing runs in between). */
const reserveInMemory = (gates: QuotaGate[]): boolean => {
  const now = Date.now();
  const allOpen = gates.every((gate) =>
    gate.some((counter) => (inMemoryQuotaCounts.get(counter.key, now) ?? 0) < counter.limit)
  );

  if (!allOpen) {
    return false;
  }

  gates.flat().forEach((counter) => {
    const current = inMemoryQuotaCounts.get(counter.key, now);
    inMemoryQuotaCounts.set(
      counter.key,
      (current ?? 0) + 1,
      counter.ttlSeconds === null ? null : now + counter.ttlSeconds * 1_000,
      now
    );
  });
  return true;
};

const releaseInMemory = (gates: QuotaGate[]): void => {
  const now = Date.now();

  gates.flat().forEach((counter) => {
    const current = inMemoryQuotaCounts.get(counter.key, now);

    if (current !== undefined && current > 0) {
      inMemoryQuotaCounts.set(
        counter.key,
        current - 1,
        counter.ttlSeconds === null ? null : now + counter.ttlSeconds * 1_000,
        now
      );
    }
  });
};

const isUpstashConfigured = (): boolean =>
  Boolean(extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN);

/** Counts the request against every gate at once, or (a gate is full) counts nothing. */
const reserveUsage = async (gates: QuotaGate[]): Promise<QuotaReservation | null> => {
  const reservation: QuotaReservation = {
    gates,
    tokenKey: `linkdish:quota-reservation:${quotaAccountingVersion}:${randomUUID()}`
  };

  if (!isUpstashConfigured()) {
    return reserveInMemory(gates) ? reservation : null;
  }

  const args = [
    String(QUOTA_RESERVATION_TTL_SECONDS),
    String(gates.length),
    ...gates.flatMap((gate) => [
      String(gate.length),
      ...gate.flatMap((counter) => [String(counter.limit), String(counter.ttlSeconds ?? 0)])
    ])
  ];
  const result = await evalWithUpstash(
    reserveQuotaScript,
    [reservation.tokenKey, ...gates.flat().map((counter) => counter.key)],
    args
  );

  return Number(result) === 1 ? reservation : null;
};

/** Gives back what reserveUsage counted, for a request that didn't import anything. */
const releaseUsage = async (reservation: QuotaReservation): Promise<void> => {
  if (!isUpstashConfigured()) {
    releaseInMemory(reservation.gates);
    return;
  }

  await evalWithUpstash(
    releaseQuotaScript,
    [reservation.tokenKey, ...reservation.gates.flat().map((counter) => counter.key)],
    []
  );
};

/** Tries a release again after a failure (a blip reaching Upstash), waiting longer each time. */
const QUOTA_RELEASE_ATTEMPTS = 3;
const QUOTA_RELEASE_RETRY_MS = 100;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/* The allowance that runs out first (a fallback import needs both imports and strong extractions). */
const getMostConstrainingQuota = (entries: QuotaUsageEntry[]): QuotaStatus | null =>
  entries.reduce<QuotaUsageEntry | null>(
    (lowest, entry) => (lowest && lowest.quota.remaining <= entry.quota.remaining ? lowest : entry),
    null
  )?.quota ?? null;

const getRequiredQuotaKinds = (attempt: "primary" | "fallback"): QuotaKind[] =>
  attempt === "fallback" ? ["imports", "strongExtractions"] : ["imports"];

const getPrimaryQuotaKind = (attempt: "primary" | "fallback"): QuotaKind =>
  attempt === "fallback" ? "strongExtractions" : "imports";

const noopCommitUsage = (
  _response: ExtractRecipeResponse,
  logContext: BillingAuthorizationResult["logContext"]
) => Promise.resolve(logContext);

interface QuotaSubject {
  plan: QuotaPlan;
  activeHouseholdQuota: Awaited<ReturnType<typeof getActiveHouseholdQuotaForUser>> | null;
  billingQuotaIdentity: BillingAuthorizationResult["logContext"]["billingQuotaIdentity"];
  quotaIdentityKey: string;
}

/*
 * The household lookup (which checks the owner's cached Family entitlement) and the caller's
 * own cached paid plan are read in parallel. RevenueCat itself is only called when neither
 * answers the question.
 */
const resolveQuotaSubject = async (
  authenticatedSession: Awaited<ReturnType<typeof getAuthenticatedUser>> | null,
  billingClientId: string,
  headers: RequestHeaders,
  identity?: RequestIdentity
): Promise<QuotaSubject> => {
  const [activeHouseholdQuota, cachedPlanId] = await Promise.all([
    authenticatedSession ? getActiveHouseholdQuotaForUser(authenticatedSession.user.id) : null,
    authenticatedSession ? peekCachedRevenueCatBillingPlanId(billingClientId) : null
  ]);
  const plan = activeHouseholdQuota
    ? familyPlan()
    : await getQuotaPlan(billingClientId, Boolean(authenticatedSession), cachedPlanId);
  const { billingQuotaIdentity, quotaIdentityKey } = getQuotaIdentity(
    plan,
    billingClientId,
    headers,
    identity,
    activeHouseholdQuota?.householdId ?? null
  );

  return { plan, activeHouseholdQuota, billingQuotaIdentity, quotaIdentityKey };
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
    const { plan, activeHouseholdQuota, billingQuotaIdentity, quotaIdentityKey } =
      await resolveQuotaSubject(authenticatedSession, billingClientId, headers, identity);
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

    // Reserve the allowance before anything is spent: a parallel request that took the last one
    // since the counts above were read is refused here, as if it had been read that way.
    const gates = requiredQuotaKinds.map((requiredQuotaKind) =>
      getQuotaGate(plan, quotaIdentityKey, requiredQuotaKind)
    );

    const reservation = await reserveUsage(gates);

    if (!reservation) {
      const refusedEntries = await Promise.all(
        requiredQuotaKinds.map((requiredQuotaKind) =>
          readUsage(plan, quotaIdentityKey, requiredQuotaKind)
        )
      );
      const refused =
        refusedEntries.find((entry) => entry.quotaCount >= entry.quotaLimit) ??
        refusedEntries.find((entry) => entry.quotaKind === quotaKind) ??
        refusedEntries[0];
      const refusedLogContext = {
        ...logContext,
        meteringMode: refused?.meteringMode ?? logContext.meteringMode,
        quotaCount: refused?.quotaCount ?? logContext.quotaCount,
        quotaKind: refused?.quotaKind ?? quotaKind,
        quotaLimit: refused?.quotaLimit ?? logContext.quotaLimit
      };

      return {
        allowed: false,
        response: failureResponse(
          getQuotaFailureMessage(plan, refused?.quotaKind ?? quotaKind),
          refused?.quota
        ),
        commitUsage: (response) => noopCommitUsage(response, refusedLogContext),
        logContext: refusedLogContext
      };
    }

    /**
     * A success keeps the reservation; anything else gives it back, once. A release that fails
     * is tried again (it is safe to: see releaseQuotaScript), and the reservation only counts as
     * given back once a release went through, so a later call can still try.
     */
    let kept = false;
    let givenBack = false;
    let releasing: Promise<void> | null = null;
    const giveBack = (): Promise<void> => {
      if (kept || givenBack) {
        return Promise.resolve();
      }

      releasing ??= (async () => {
        try {
          for (let attempt = 1; ; attempt += 1) {
            try {
              await releaseUsage(reservation);
              givenBack = true;
              return;
            } catch (error) {
              if (attempt >= QUOTA_RELEASE_ATTEMPTS) {
                console.error(error);
                return;
              }

              await wait(QUOTA_RELEASE_RETRY_MS * 2 ** (attempt - 1));
            }
          }
        } finally {
          releasing = null;
        }
      })();

      return releasing;
    };

    const commitUsageWithQuota = async (
      response: ExtractRecipeResponse
    ): Promise<CommittedUsage> => {
      if (response.status !== "success") {
        await giveBack();
        return { logContext, quota: null };
      }

      kept = true;
      // Counted when it was reserved: read the allowance that leaves.
      const committedEntries = await Promise.all(
        requiredQuotaKinds.map((requiredQuotaKind) =>
          readUsage(plan, quotaIdentityKey, requiredQuotaKind)
        )
      );
      const committedPrimaryUsage =
        committedEntries.find((entry) => entry.quotaKind === quotaKind) ?? committedEntries[0];

      return {
        logContext: {
          ...logContext,
          meteringMode: committedPrimaryUsage?.meteringMode ?? logContext.meteringMode,
          quotaCount: committedPrimaryUsage?.quotaCount ?? logContext.quotaCount,
          quotaLimit: committedPrimaryUsage?.quotaLimit ?? logContext.quotaLimit
        },
        quota: getMostConstrainingQuota(committedEntries)
      };
    };

    return {
      allowed: true,
      commitUsage: async (response) => (await commitUsageWithQuota(response)).logContext,
      commitUsageWithQuota,
      logContext,
      releaseUsage: giveBack
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

/**
 * GET /billing/usage: the caller's current allowance, resolved exactly like an extraction's
 * (same identity, plan and quota keys) but read-only. Reports the allowance that runs out
 * first. `quota` is null when billing is off, for the live canary, or when the install cannot
 * be identified.
 */
export const readBillingUsage = async (
  headers: RequestHeaders,
  identity?: RequestIdentity
): Promise<BillingUsageResponse> => {
  if (!extractorApiEnv.BILLING_ENFORCEMENT_ENABLED) {
    return { billingEnabled: false, plan: null, quota: null };
  }

  if (isAuthorizedCanaryRequest(headers)) {
    return { billingEnabled: true, plan: "plus", quota: null };
  }

  const authenticatedSession = extractorApiEnv.HOUSEHOLDS_ENABLED
    ? await getAuthenticatedUser(headers).catch(() => null)
    : null;
  const billingClientId = authenticatedSession?.user.id ?? getClientId(headers);

  if (!billingClientId) {
    return { billingEnabled: true, plan: null, quota: null };
  }

  const { plan, quotaIdentityKey } = await resolveQuotaSubject(
    authenticatedSession,
    billingClientId,
    headers,
    identity
  );
  const entries = await Promise.all(
    getRequiredQuotaKinds("fallback").map((quotaKind) =>
      readUsage(plan, quotaIdentityKey, quotaKind)
    )
  );

  return { billingEnabled: true, plan: plan.id, quota: getMostConstrainingQuota(entries) };
};
