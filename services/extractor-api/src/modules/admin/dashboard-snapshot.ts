import { extractorApiEnv } from "../../config/env.js";
import { getAnalyticsDashboardSummary } from "../analytics/analytics-store.js";
import { authKeys } from "../auth/auth-service.js";
import { getSharedExtractorRuntime } from "../extract/services/runtime.js";
import { countStoreKeys } from "../storage/upstash-store.js";
import { getIosWaitlistSnapshot } from "../waitlist/ios-waitlist-service.js";

import { getAdminEnvironmentProfile, parseAdminEnvironmentName } from "./environment-profiles.js";
import { getAdminMetricsSnapshot } from "./metrics.js";
import { getAdminCatalogWithModel, isManagedFallbackExtractor } from "./model-control.js";
import { getAdminProviderLiveSnapshots } from "./provider-monitoring.js";

import type { AdminEnvironmentProfile } from "./environment-profiles.js";
import type { AdminMetricsSnapshot } from "./metrics.js";
import type { AdminModelOption } from "./model-control.js";
import type { ExtractorRuntime } from "../extract/types.js";

type ProviderLimitStatus = "ok" | "watch" | "upgrade" | "missing" | "unknown";

interface ProviderLimitItem {
  id: string;
  provider: string;
  area: string;
  status: ProviderLimitStatus;
  usageLabel: string;
  limitLabel: string;
  utilizationPct: number | null;
  source: string;
  upgradeGuidance: string;
}

const formatWindow = (windowMs: number): string => {
  if (windowMs % 60_000 === 0) {
    const minutes = windowMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  if (windowMs % 1_000 === 0) {
    const seconds = windowMs / 1_000;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }

  return `${windowMs} ms`;
};

const getUtilizationStatus = (utilizationPct: number | null): ProviderLimitStatus => {
  if (utilizationPct == null) {
    return "unknown";
  }

  if (utilizationPct >= 90) {
    return "upgrade";
  }

  if (utilizationPct >= 70) {
    return "watch";
  }

  return "ok";
};

const getRecentRequestCountForWindow = (
  metrics: AdminMetricsSnapshot,
  windowMs: number,
  now = Date.now()
): number =>
  metrics.recentRequests.filter((request) => now - Date.parse(request.timestamp) <= windowMs)
    .length;

const getHighestQuotaObservation = (
  metrics: AdminMetricsSnapshot
): { label: string; utilizationPct: number } | null => {
  let highestObservation: { label: string; utilizationPct: number } | null = null;

  for (const request of metrics.recentRequests) {
    const match = request.quota?.match(/^([a-zA-Z]+): (\d+)\/(\d+)$/u);

    if (!match) {
      continue;
    }

    const [, quotaKind, rawCount, rawLimit] = match;
    const count = Number(rawCount);
    const limit = Number(rawLimit);

    if (!Number.isFinite(count) || !Number.isFinite(limit) || limit <= 0) {
      continue;
    }

    const utilizationPct = Math.min(100, Math.round((count / limit) * 1000) / 10);

    if (!highestObservation || utilizationPct > highestObservation.utilizationPct) {
      highestObservation = {
        label: `${quotaKind}: ${count}/${limit}`,
        utilizationPct
      };
    }
  }

  return highestObservation;
};

const getActiveModelPrice = (
  environmentProfile: AdminEnvironmentProfile,
  llmCatalog: AdminModelOption[]
) =>
  llmCatalog.find(
    (model) =>
      model.provider === environmentProfile.llm.selectedProvider &&
      model.model === environmentProfile.llm.activeModel
  )?.price;

const buildProviderLimits = ({
  activePrice,
  estimatedSpendUsd,
  environmentProfile,
  metrics
}: {
  activePrice: AdminModelOption["price"] | undefined;
  estimatedSpendUsd: number;
  environmentProfile: AdminEnvironmentProfile;
  metrics: AdminMetricsSnapshot;
}): ProviderLimitItem[] => {
  const recentRequestCount = getRecentRequestCountForWindow(
    metrics,
    environmentProfile.runtime.rateLimitWindowMs
  );
  const rateLimitUtilizationPct = Math.min(
    100,
    Math.round((recentRequestCount / environmentProfile.runtime.rateLimitMax) * 1000) / 10
  );
  const highestQuotaObservation = getHighestQuotaObservation(metrics);
  const llmBudget = environmentProfile.runtime.llmFallbackDailyBudgetUsd;
  const llmBudgetUtilizationPct =
    llmBudget > 0 ? Math.min(100, Math.round((estimatedSpendUsd / llmBudget) * 1000) / 10) : null;
  const selectedLlmProvider = environmentProfile.llm.selectedProvider;
  const selectedProviderCredentialConfigured =
    selectedLlmProvider === "gemini"
      ? environmentProfile.llm.credentials.gemini
      : selectedLlmProvider === "openai"
        ? environmentProfile.llm.credentials.openai
        : false;
  const llmStatus =
    selectedLlmProvider === "none"
      ? "unknown"
      : !selectedProviderCredentialConfigured || !environmentProfile.llm.activeModel
        ? "missing"
        : getUtilizationStatus(llmBudgetUtilizationPct);

  return [
    {
      id: "api-rate-limit",
      provider: "Extractor API",
      area: "Ingress rate limit",
      status: getUtilizationStatus(rateLimitUtilizationPct),
      usageLabel: `${recentRequestCount}/${environmentProfile.runtime.rateLimitMax} recent requests`,
      limitLabel: `${environmentProfile.runtime.rateLimitMax} per ${formatWindow(
        environmentProfile.runtime.rateLimitWindowMs
      )}`,
      utilizationPct: rateLimitUtilizationPct,
      source: "Process-local recent request log",
      upgradeGuidance:
        "Upgrade API hosting capacity, add caching, or raise RATE_LIMIT_MAX when this is sustained above 70%."
    },
    {
      id: "plan-quotas",
      provider: "LinkDish billing",
      area: "User import quotas",
      status: highestQuotaObservation
        ? getUtilizationStatus(highestQuotaObservation.utilizationPct)
        : "unknown",
      usageLabel: highestQuotaObservation?.label ?? "No quota observations yet",
      limitLabel: environmentProfile.plans
        .map(
          (plan) =>
            `${plan.displayName}: ${plan.monthlyImports}${plan.id === "free" ? " total" : "/mo"}`
        )
        .join(" | "),
      utilizationPct: highestQuotaObservation?.utilizationPct ?? null,
      source: "Recent extraction billing context",
      upgradeGuidance:
        "If paid plans frequently approach their monthly quota, raise plan limits only after confirming provider costs and API capacity."
    },
    {
      id: "llm-fallback",
      provider:
        selectedLlmProvider === "none" ? "LLM fallback" : providerLabel(selectedLlmProvider),
      area: "Fallback model spend",
      status: llmStatus,
      usageLabel:
        selectedLlmProvider === "none"
          ? "Disabled"
          : `${metrics.fallbackAttemptCount} fallback attempts, ${metrics.llmSuccessCount} LLM successes, est. $${estimatedSpendUsd.toFixed(
              4
            )}`,
      limitLabel:
        llmBudget > 0 ? `$${llmBudget.toFixed(2)} dashboard budget` : "No dashboard budget set",
      utilizationPct: llmBudgetUtilizationPct,
      source:
        activePrice?.source === "provider_docs" ? "Catalog pricing estimate" : "Unverified pricing",
      upgradeGuidance:
        "Upgrade or switch model/provider when fallback volume or estimated spend approaches the budget."
    },
    {
      id: "browser-fetch",
      provider: "Browser runtime",
      area: "Dynamic page fetches",
      status: environmentProfile.runtime.browserFetchEnabled ? "ok" : "watch",
      usageLabel: `${metrics.browserFetchCount} browser fetch attempts`,
      limitLabel: `${environmentProfile.runtime.browserFetchConcurrency} concurrent fetches`,
      utilizationPct: null,
      source: "Process-local extraction metrics",
      upgradeGuidance:
        "Increase host memory/CPU or BROWSER_FETCH_CONCURRENCY if dynamic sources queue or latency rises."
    },
    {
      id: "upstash",
      provider: "Upstash Redis",
      area: "Durable quotas, rate limits, admin settings, households",
      status: environmentProfile.billing.upstashConfigured
        ? "ok"
        : environmentProfile.environment === "production"
          ? "missing"
          : "watch",
      usageLabel: environmentProfile.billing.storageMode,
      limitLabel: "Provider plan command and storage limits",
      utilizationPct: null,
      source: "Environment configuration",
      upgradeGuidance:
        "Check Upstash command and storage charts; upgrade before rate-limit or quota writes throttle."
    },
    {
      id: "revenuecat",
      provider: "RevenueCat",
      area: "Entitlement checks",
      status:
        environmentProfile.billing.enforcementEnabled &&
        !environmentProfile.billing.revenueCatConfigured
          ? "missing"
          : "ok",
      usageLabel: environmentProfile.billing.enforcementEnabled
        ? "Billing enforcement enabled"
        : "Billing enforcement disabled",
      limitLabel: `Plus: ${environmentProfile.billing.revenueCatEntitlementId}, Family: ${environmentProfile.billing.revenueCatFamilyEntitlementId}`,
      utilizationPct: null,
      source: "Environment configuration",
      upgradeGuidance:
        "Monitor RevenueCat subscriber and API usage; upgrade if entitlement checks or subscriber counts approach plan limits."
    },
    {
      id: "resend",
      provider: "Resend",
      area: "Login and household invite email",
      status:
        environmentProfile.integrations.householdsEnabled &&
        (!environmentProfile.integrations.resendConfigured ||
          !environmentProfile.integrations.authEmailConfigured)
          ? "missing"
          : "ok",
      usageLabel: environmentProfile.integrations.householdsEnabled
        ? "Households/auth email enabled"
        : "Households disabled",
      limitLabel: `Sign-in throttle: ${environmentProfile.runtime.authLoginCodeRateLimitMax} per ${formatWindow(
        environmentProfile.runtime.authLoginCodeRateLimitWindowMs
      )}; provider email send limits`,
      utilizationPct: null,
      source: "Environment configuration",
      upgradeGuidance:
        "Watch Resend monthly and daily sends as household invites and login volume grow."
    }
  ];
};

const providerLabel = (provider: "gemini" | "openai"): string =>
  provider === "gemini" ? "Gemini" : "OpenAI";

const getAdminIosWaitlistSnapshot = async () => {
  try {
    return {
      ...(await getIosWaitlistSnapshot(100)),
      error: null
    };
  } catch (error) {
    return {
      entries: [],
      error: error instanceof Error ? error.message : "Unable to load iOS waitlist.",
      hasMore: false,
      limit: 100,
      total: 0
    };
  }
};

const getAdminAccountsSnapshot = async () => {
  try {
    return {
      totalUsers: await countStoreKeys(authKeys.user("*")),
      error: null
    };
  } catch (error) {
    return {
      totalUsers: null,
      error: error instanceof Error ? error.message : "Unable to count user accounts."
    };
  }
};

export const getAdminDashboardSnapshot = async (
  runtime: ExtractorRuntime = getSharedExtractorRuntime(),
  selectedEnvironment = parseAdminEnvironmentName(process.env.VERCEL_ENV) ?? "development"
) => {
  const metrics = getAdminMetricsSnapshot();
  const runtimeLlm = isManagedFallbackExtractor(runtime.fallbackExtractor)
    ? await runtime.fallbackExtractor.getState()
    : {
        selectedProvider: runtime.fallbackExtractor.providerName,
        runtimeProvider: runtime.fallbackExtractor.providerName,
        available: runtime.fallbackExtractor.available,
        activeModel: null,
        geminiModel: null,
        openAiModel: null,
        updatedAt: null,
        updatedBy: "env" as const,
        configSource: "env" as const,
        credentials: {
          gemini: Boolean(extractorApiEnv.GEMINI_API_KEY),
          openai: Boolean(extractorApiEnv.OPENAI_API_KEY)
        },
        catalog: [],
        persistence: {
          configured: false,
          key: "",
          lastLoadedAt: null,
          loadError: null
        },
        notes: ["This runtime was injected without admin model controls."]
      };
  const environmentProfile = getAdminEnvironmentProfile(selectedEnvironment);
  const llmCatalog = getAdminCatalogWithModel(
    environmentProfile.llm.selectedProvider,
    environmentProfile.llm.activeModel,
    runtimeLlm.catalog
  );
  const activePrice = getActiveModelPrice(environmentProfile, llmCatalog);
  const estimatedInputTokensPerRequest = 8_000;
  const estimatedOutputTokensPerRequest = 1_500;
  const estimatedSpendUsd =
    activePrice?.inputUsdPerMillionTokens == null || activePrice.outputUsdPerMillionTokens == null
      ? 0
      : (metrics.fallbackAttemptCount *
          estimatedInputTokensPerRequest *
          activePrice.inputUsdPerMillionTokens) /
          1_000_000 +
        (metrics.fallbackAttemptCount *
          estimatedOutputTokensPerRequest *
          activePrice.outputUsdPerMillionTokens) /
          1_000_000;
  const notes = [
    "Analytics are process-local until a durable event store is connected.",
    "LLM spend uses documented model rates and estimated token counts until provider billing APIs are connected."
  ];

  if (!extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
    notes.push("Set ADMIN_DASHBOARD_TOKEN before exposing /admin outside localhost.");
  }

  if (selectedEnvironment !== environmentProfile.runtimeEnvironment) {
    notes.push(
      "The selected Vercel env profile is read-only here; model changes apply to the running API process."
    );
  }
  const providerHub = await getAdminProviderLiveSnapshots();
  const iosWaitlist = await getAdminIosWaitlistSnapshot();
  const durableAnalytics = await getAnalyticsDashboardSummary();
  const accounts = await getAdminAccountsSnapshot();

  return {
    generatedAt: new Date().toISOString(),
    environment: environmentProfile,
    runtime: {
      uptimeSeconds: process.uptime(),
      nodeEnv: extractorApiEnv.NODE_ENV,
      port: extractorApiEnv.PORT,
      corsOrigin: extractorApiEnv.CORS_ORIGIN,
      authLoginCodeRateLimitMax: extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX,
      authLoginCodeRateLimitWindowMs: extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS,
      rateLimitMax: extractorApiEnv.RATE_LIMIT_MAX,
      rateLimitWindowMs: extractorApiEnv.RATE_LIMIT_WINDOW_MS,
      browserFetchEnabled: extractorApiEnv.BROWSER_FETCH_ENABLED,
      browserFetchConcurrency: extractorApiEnv.BROWSER_FETCH_CONCURRENCY,
      llmFallbackTimeoutMs: extractorApiEnv.LLM_FALLBACK_TIMEOUT_MS,
      llmFallbackDailyBudgetUsd: extractorApiEnv.LLM_FALLBACK_DAILY_BUDGET_USD
    },
    security: {
      enabled: extractorApiEnv.ADMIN_DASHBOARD_ENABLED,
      authMode: extractorApiEnv.ADMIN_DASHBOARD_TOKEN
        ? "ADMIN_DASHBOARD_TOKEN"
        : "Localhost only until ADMIN_DASHBOARD_TOKEN is set"
    },
    billing: environmentProfile.billing,
    plans: environmentProfile.plans,
    llm: {
      ...runtimeLlm,
      catalog: llmCatalog
    },
    analytics: metrics,
    durableAnalytics,
    pricing: {
      estimatedSpendUsd,
      estimatedInputTokensPerFallbackRequest: estimatedInputTokensPerRequest,
      estimatedOutputTokensPerFallbackRequest: estimatedOutputTokensPerRequest,
      dailyBudgetUsd: extractorApiEnv.LLM_FALLBACK_DAILY_BUDGET_USD
    },
    providerLimits: buildProviderLimits({
      activePrice,
      estimatedSpendUsd,
      environmentProfile,
      metrics
    }),
    providerHub,
    iosWaitlist,
    accounts,
    notes
  };
};
