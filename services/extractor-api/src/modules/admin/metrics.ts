import type { QuotaMeteringMode } from "../../../../../packages/api-contracts/src/index.js";
import type { ExtractionLogContext } from "../extract/types.js";

type OutcomeStatus = ExtractionLogContext["outcomeStatus"] | "blocked";
type BillingPlan = "free" | "plus" | "family" | "disabled" | "unknown";

interface BillingLogContext {
  accountUserId: string | null;
  billingClientId: string | null;
  billingEnabled: boolean;
  billingQuotaIdentity: "client" | "disabled" | "household" | "network" | "unknown";
  billingPlan: BillingPlan;
  householdId: string | null;
  householdRole: "member" | "owner" | null;
  meteringMode: QuotaMeteringMode;
  quotaCount: number | null;
  quotaKind: "imports" | "strongExtractions" | null;
  quotaLimit: number | null;
}

export interface AdminExtractionEventInput {
  extraction: Omit<ExtractionLogContext, "latencyMs"> | null;
  billing: BillingLogContext;
  latencyMs: number;
  blockedReason?: string;
}

export interface AdminRecentRequest {
  timestamp: string;
  hostname: string;
  attempt: "primary" | "fallback" | "blocked";
  status: OutcomeStatus;
  strategy: string;
  sourceType: string;
  fetchMode: string;
  fallbackProvider: string;
  confidenceScore: number | null;
  latencyMs: number;
  billingPlan: BillingPlan;
  quota: string | null;
  blockedReason: string | null;
}

export interface AdminMetricsSnapshot {
  startedAt: string;
  totalRequests: number;
  successCount: number;
  needsRetryCount: number;
  failureCount: number;
  blockedCount: number;
  fallbackAttemptCount: number;
  llmSuccessCount: number;
  browserFetchCount: number;
  blockedSourceSignalCount: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  counts: {
    byStatus: Record<string, number>;
    byPlan: Record<string, number>;
    byProvider: Record<string, number>;
    bySourceType: Record<string, number>;
    byStrategy: Record<string, number>;
  };
  recentRequests: AdminRecentRequest[];
}

const maxRecentRequests = 80;
const startedAt = new Date().toISOString();
const recentRequests: AdminRecentRequest[] = [];
const latencies: number[] = [];

const counters = {
  totalRequests: 0,
  successCount: 0,
  needsRetryCount: 0,
  failureCount: 0,
  blockedCount: 0,
  fallbackAttemptCount: 0,
  llmSuccessCount: 0,
  browserFetchCount: 0,
  blockedSourceSignalCount: 0,
  byStatus: new Map<string, number>(),
  byPlan: new Map<string, number>(),
  byProvider: new Map<string, number>(),
  bySourceType: new Map<string, number>(),
  byStrategy: new Map<string, number>()
};

const increment = (map: Map<string, number>, key: string) => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const toRecord = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));

const getQuotaText = (billing: BillingLogContext): string | null => {
  if (!billing.quotaKind || billing.quotaCount == null || billing.quotaLimit == null) {
    return null;
  }

  return `${billing.quotaKind}: ${billing.quotaCount}/${billing.quotaLimit}`;
};

const getP95 = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sortedValues.length * 0.95) - 1);
  return sortedValues[index] ?? 0;
};

export const recordAdminExtractionEvent = (event: AdminExtractionEventInput): void => {
  const status = event.extraction?.outcomeStatus ?? "blocked";
  const attempt = event.extraction?.attempt ?? "blocked";
  const strategy = event.extraction?.strategy ?? "none";
  const sourceType = event.extraction?.sourceType ?? "unknown";
  const fallbackProvider = event.extraction?.fallbackProvider ?? "none";

  counters.totalRequests += 1;
  counters.successCount += status === "success" ? 1 : 0;
  counters.needsRetryCount += status === "needs_retry" ? 1 : 0;
  counters.failureCount += status === "failure" ? 1 : 0;
  counters.blockedCount += status === "blocked" ? 1 : 0;
  counters.fallbackAttemptCount += attempt === "fallback" ? 1 : 0;
  counters.llmSuccessCount += status === "success" && strategy === "llm-fallback" ? 1 : 0;
  counters.browserFetchCount += event.extraction?.browserAttempted ? 1 : 0;
  counters.blockedSourceSignalCount += event.extraction?.blockedSignals.length ?? 0;

  increment(counters.byStatus, status);
  increment(counters.byPlan, event.billing.billingPlan);
  increment(counters.byProvider, fallbackProvider);
  increment(counters.bySourceType, sourceType);
  increment(counters.byStrategy, strategy);

  latencies.push(event.latencyMs);

  if (latencies.length > 500) {
    latencies.shift();
  }

  recentRequests.unshift({
    timestamp: new Date().toISOString(),
    hostname: event.extraction?.hostname ?? "unknown",
    attempt,
    status,
    strategy,
    sourceType,
    fetchMode: event.extraction?.fetchMode ?? "none",
    fallbackProvider,
    confidenceScore: event.extraction?.confidenceScore ?? null,
    latencyMs: event.latencyMs,
    billingPlan: event.billing.billingPlan,
    quota: getQuotaText(event.billing),
    blockedReason: event.blockedReason ?? null
  });

  if (recentRequests.length > maxRecentRequests) {
    recentRequests.length = maxRecentRequests;
  }
};

export const getAdminMetricsSnapshot = (): AdminMetricsSnapshot => {
  const averageLatencyMs =
    latencies.length === 0
      ? 0
      : Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length);

  return {
    startedAt,
    totalRequests: counters.totalRequests,
    successCount: counters.successCount,
    needsRetryCount: counters.needsRetryCount,
    failureCount: counters.failureCount,
    blockedCount: counters.blockedCount,
    fallbackAttemptCount: counters.fallbackAttemptCount,
    llmSuccessCount: counters.llmSuccessCount,
    browserFetchCount: counters.browserFetchCount,
    blockedSourceSignalCount: counters.blockedSourceSignalCount,
    averageLatencyMs,
    p95LatencyMs: getP95(latencies),
    successRate:
      counters.totalRequests === 0
        ? 0
        : Math.round((counters.successCount / counters.totalRequests) * 1000) / 10,
    counts: {
      byStatus: toRecord(counters.byStatus),
      byPlan: toRecord(counters.byPlan),
      byProvider: toRecord(counters.byProvider),
      bySourceType: toRecord(counters.bySourceType),
      byStrategy: toRecord(counters.byStrategy)
    },
    recentRequests
  };
};
