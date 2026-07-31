import { existsSync, readFileSync } from "node:fs";

import { parse } from "dotenv";

import { extractorApiEnv } from "../../config/env.js";

export type AdminEnvironmentName = "development" | "production";

interface RawProfile {
  values: Record<string, string>;
  source: string;
}

export interface AdminEnvironmentProfile {
  environment: AdminEnvironmentName;
  available: boolean;
  source: string;
  runtimeEnvironment: AdminEnvironmentName;
  llm: {
    selectedProvider: "gemini" | "openai" | "none";
    activeModel: string | null;
    geminiModel: string | null;
    openAiModel: string | null;
    credentials: {
      gemini: boolean;
      openai: boolean;
    };
  };
  billing: {
    enforcementEnabled: boolean;
    revenueCatConfigured: boolean;
    revenueCatEntitlementId: string;
    revenueCatFamilyEntitlementId: string;
    testPremiumPlanId: "plus" | "family";
    testPremiumUserIdsConfigured: boolean;
    upstashConfigured: boolean;
    storageMode: "Upstash Redis" | "In-memory fallback";
  };
  integrations: {
    authEmailConfigured: boolean;
    authSecretConfigured: boolean;
    householdsEnabled: boolean;
    resendConfigured: boolean;
  };
  runtime: {
    authLoginCodeRateLimitMax: number;
    authLoginCodeRateLimitWindowMs: number;
    rateLimitMax: number;
    rateLimitWindowMs: number;
    browserFetchEnabled: boolean;
    browserFetchConcurrency: number;
    llmFallbackTimeoutMs: number;
    llmFallbackDailyBudgetUsd: number;
  };
  plans: Array<{
    id: "free" | "plus" | "family";
    displayName: string;
    monthlyPrice: string;
    yearlyPrice: string;
    monthlyImports: number;
    monthlyStrongExtractions: number;
    savedRecipes: string;
  }>;
  notes: string[];
}

const envFileByEnvironment = {
  development: "../../../.env.development.local",
  production: "../../../.env.production.local"
} as const;

const defaults = {
  authLoginCodeRateLimitMax: 5,
  authLoginCodeRateLimitWindowMs: 600_000,
  rateLimitMax: 60,
  rateLimitWindowMs: 60_000,
  browserFetchEnabled: true,
  browserFetchConcurrency: 2,
  llmFallbackTimeoutMs: 30_000,
  llmFallbackDailyBudgetUsd: 0,
  freeLifetimeImports: 3,
  plusMonthlyImports: 100,
  familyMonthlyImports: 250,
  revenueCatEntitlementId: "Plus",
  revenueCatFamilyEntitlementId: "Family"
} as const;

export const parseAdminEnvironmentName = (value: unknown): AdminEnvironmentName | null =>
  value === "development" || value === "production" ? value : null;

export const getRuntimeEnvironmentName = (): AdminEnvironmentName =>
  process.env.VERCEL_ENV === "production" ? "production" : "development";

const getTrimmed = (
  values: Record<string, string>,
  key: string,
  fallback?: string
): string | undefined => {
  const value = values[key] ?? fallback;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const getNumber = (values: Record<string, string>, key: string, fallback: number): number => {
  const value = Number(getTrimmed(values, key));
  return Number.isFinite(value) ? value : fallback;
};

const getBoolean = (values: Record<string, string>, key: string, fallback: boolean): boolean => {
  const value = getTrimmed(values, key);

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return fallback;
};

const getProvider = (values: Record<string, string>): "gemini" | "openai" | "none" => {
  const provider = getTrimmed(values, "LLM_PROVIDER");

  return provider === "gemini" || provider === "openai" ? provider : "none";
};

const getFileProfile = (environment: AdminEnvironmentName): RawProfile | null => {
  const fileUrl = new URL(envFileByEnvironment[environment], import.meta.url);

  if (!existsSync(fileUrl)) {
    return null;
  }

  return {
    values: parse(readFileSync(fileUrl)),
    source: envFileByEnvironment[environment].replace("../../../", "")
  };
};

const getRuntimeProfile = (): RawProfile => ({
  values: {
    BILLING_ENFORCEMENT_ENABLED: String(extractorApiEnv.BILLING_ENFORCEMENT_ENABLED),
    BROWSER_FETCH_CONCURRENCY: String(extractorApiEnv.BROWSER_FETCH_CONCURRENCY),
    BROWSER_FETCH_ENABLED: String(extractorApiEnv.BROWSER_FETCH_ENABLED),
    FREE_LIFETIME_IMPORT_LIMIT: String(extractorApiEnv.FREE_LIFETIME_IMPORT_LIMIT),
    FAMILY_MONTHLY_IMPORT_LIMIT: String(extractorApiEnv.FAMILY_MONTHLY_IMPORT_LIMIT),
    GEMINI_API_KEY: extractorApiEnv.GEMINI_API_KEY ?? "",
    GEMINI_MODEL: extractorApiEnv.GEMINI_MODEL ?? "",
    LLM_FALLBACK_DAILY_BUDGET_USD: String(extractorApiEnv.LLM_FALLBACK_DAILY_BUDGET_USD),
    LLM_FALLBACK_TIMEOUT_MS: String(extractorApiEnv.LLM_FALLBACK_TIMEOUT_MS),
    LLM_PROVIDER: extractorApiEnv.LLM_PROVIDER,
    OPENAI_API_KEY: extractorApiEnv.OPENAI_API_KEY ?? "",
    OPENAI_MODEL: extractorApiEnv.OPENAI_MODEL ?? "",
    PLUS_MONTHLY_IMPORT_LIMIT: String(extractorApiEnv.PLUS_MONTHLY_IMPORT_LIMIT),
    RATE_LIMIT_MAX: String(extractorApiEnv.RATE_LIMIT_MAX),
    RATE_LIMIT_WINDOW_MS: String(extractorApiEnv.RATE_LIMIT_WINDOW_MS),
    REVENUECAT_ENTITLEMENT_ID: extractorApiEnv.REVENUECAT_ENTITLEMENT_ID,
    REVENUECAT_FAMILY_ENTITLEMENT_ID: extractorApiEnv.REVENUECAT_FAMILY_ENTITLEMENT_ID,
    REVENUECAT_PLUS_ENTITLEMENT_ID: extractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID,
    REVENUECAT_PROJECT_ID: extractorApiEnv.REVENUECAT_PROJECT_ID ?? "",
    REVENUECAT_SECRET_API_KEY: extractorApiEnv.REVENUECAT_SECRET_API_KEY ?? "",
    LINKDISH_TEST_PREMIUM_PLAN_ID: extractorApiEnv.LINKDISH_TEST_PREMIUM_PLAN_ID,
    LINKDISH_TEST_PREMIUM_USER_IDS: extractorApiEnv.LINKDISH_TEST_PREMIUM_USER_IDS ?? "",
    AUTH_EMAIL_FROM: extractorApiEnv.AUTH_EMAIL_FROM ?? "",
    AUTH_LOGIN_CODE_RATE_LIMIT_MAX: String(extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX),
    AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS: String(
      extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS
    ),
    AUTH_SECRET: extractorApiEnv.AUTH_SECRET ?? "",
    HOUSEHOLDS_ENABLED: String(extractorApiEnv.HOUSEHOLDS_ENABLED),
    LINKDISH_PUBLIC_SITE_URL: extractorApiEnv.LINKDISH_PUBLIC_SITE_URL ?? "",
    RESEND_API_KEY: extractorApiEnv.RESEND_API_KEY ?? "",
    UPSTASH_REDIS_REST_TOKEN: extractorApiEnv.UPSTASH_REDIS_REST_TOKEN ?? "",
    UPSTASH_REDIS_REST_URL: extractorApiEnv.UPSTASH_REDIS_REST_URL ?? "",
    VERCEL_API_TOKEN: extractorApiEnv.VERCEL_API_TOKEN ?? "",
    VERCEL_PROJECT_ID: extractorApiEnv.VERCEL_PROJECT_ID ?? "",
    VERCEL_TEAM_ID: extractorApiEnv.VERCEL_TEAM_ID ?? ""
  },
  source: "current process environment"
});

const getRawProfile = (environment: AdminEnvironmentName): RawProfile => {
  const fileProfile = getFileProfile(environment);

  if (fileProfile) {
    return fileProfile;
  }

  if (environment === getRuntimeEnvironmentName()) {
    return getRuntimeProfile();
  }

  return {
    values: {},
    source: "missing local Vercel env pull"
  };
};

const formatSavedRecipeLimit = (value: number | null): string =>
  value == null ? "Unlimited saved recipes" : `${value} saved recipes`;

export const getAdminEnvironmentProfile = (
  environment: AdminEnvironmentName
): AdminEnvironmentProfile => {
  const rawProfile = getRawProfile(environment);
  const provider = getProvider(rawProfile.values);
  const geminiModel = getTrimmed(rawProfile.values, "GEMINI_MODEL") ?? null;
  const openAiModel = getTrimmed(rawProfile.values, "OPENAI_MODEL") ?? null;
  const revenueCatConfigured = Boolean(getTrimmed(rawProfile.values, "REVENUECAT_SECRET_API_KEY"));
  const upstashConfigured = Boolean(
    getTrimmed(rawProfile.values, "UPSTASH_REDIS_REST_URL") &&
    getTrimmed(rawProfile.values, "UPSTASH_REDIS_REST_TOKEN")
  );
  const activeModel =
    provider === "gemini" ? geminiModel : provider === "openai" ? openAiModel : null;
  const notes: string[] = [];
  const available = Object.keys(rawProfile.values).length > 0;
  const freeLifetimeImports = getNumber(
    rawProfile.values,
    "FREE_LIFETIME_IMPORT_LIMIT",
    defaults.freeLifetimeImports
  );
  const plusMonthlyImports = getNumber(
    rawProfile.values,
    "PLUS_MONTHLY_IMPORT_LIMIT",
    defaults.plusMonthlyImports
  );
  const familyMonthlyImports = getNumber(
    rawProfile.values,
    "FAMILY_MONTHLY_IMPORT_LIMIT",
    defaults.familyMonthlyImports
  );

  if (!available) {
    notes.push(
      `No ${environment} Vercel env profile is available locally. Pull it with vercel env pull.`
    );
  }

  if (provider === "gemini" && !getTrimmed(rawProfile.values, "GEMINI_API_KEY")) {
    notes.push(`${environment} selects Gemini, but GEMINI_API_KEY is missing.`);
  }

  if (provider === "openai" && !getTrimmed(rawProfile.values, "OPENAI_API_KEY")) {
    notes.push(`${environment} selects OpenAI, but OPENAI_API_KEY is missing.`);
  }

  if (provider !== "none" && !activeModel) {
    notes.push(`${environment} selects an LLM provider, but no active model is configured.`);
  }

  return {
    environment,
    available,
    source: rawProfile.source,
    runtimeEnvironment: getRuntimeEnvironmentName(),
    llm: {
      selectedProvider: provider,
      activeModel,
      geminiModel,
      openAiModel,
      credentials: {
        gemini: Boolean(getTrimmed(rawProfile.values, "GEMINI_API_KEY")),
        openai: Boolean(getTrimmed(rawProfile.values, "OPENAI_API_KEY"))
      }
    },
    billing: {
      enforcementEnabled: getBoolean(rawProfile.values, "BILLING_ENFORCEMENT_ENABLED", false),
      revenueCatConfigured,
      revenueCatEntitlementId:
        getTrimmed(rawProfile.values, "REVENUECAT_PLUS_ENTITLEMENT_ID") ??
        getTrimmed(rawProfile.values, "REVENUECAT_ENTITLEMENT_ID") ??
        defaults.revenueCatEntitlementId,
      revenueCatFamilyEntitlementId:
        getTrimmed(rawProfile.values, "REVENUECAT_FAMILY_ENTITLEMENT_ID") ??
        defaults.revenueCatFamilyEntitlementId,
      testPremiumPlanId:
        getTrimmed(rawProfile.values, "LINKDISH_TEST_PREMIUM_PLAN_ID") === "plus"
          ? "plus"
          : "family",
      testPremiumUserIdsConfigured: Boolean(
        getTrimmed(rawProfile.values, "LINKDISH_TEST_PREMIUM_USER_IDS")
      ),
      upstashConfigured,
      storageMode: upstashConfigured ? "Upstash Redis" : "In-memory fallback"
    },
    integrations: {
      authEmailConfigured: Boolean(getTrimmed(rawProfile.values, "AUTH_EMAIL_FROM")),
      authSecretConfigured: Boolean(getTrimmed(rawProfile.values, "AUTH_SECRET")),
      householdsEnabled: getBoolean(rawProfile.values, "HOUSEHOLDS_ENABLED", false),
      resendConfigured: Boolean(getTrimmed(rawProfile.values, "RESEND_API_KEY"))
    },
    runtime: {
      authLoginCodeRateLimitMax: getNumber(
        rawProfile.values,
        "AUTH_LOGIN_CODE_RATE_LIMIT_MAX",
        defaults.authLoginCodeRateLimitMax
      ),
      authLoginCodeRateLimitWindowMs: getNumber(
        rawProfile.values,
        "AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS",
        defaults.authLoginCodeRateLimitWindowMs
      ),
      rateLimitMax: getNumber(rawProfile.values, "RATE_LIMIT_MAX", defaults.rateLimitMax),
      rateLimitWindowMs: getNumber(
        rawProfile.values,
        "RATE_LIMIT_WINDOW_MS",
        defaults.rateLimitWindowMs
      ),
      browserFetchEnabled: getBoolean(
        rawProfile.values,
        "BROWSER_FETCH_ENABLED",
        defaults.browserFetchEnabled
      ),
      browserFetchConcurrency: getNumber(
        rawProfile.values,
        "BROWSER_FETCH_CONCURRENCY",
        defaults.browserFetchConcurrency
      ),
      llmFallbackTimeoutMs: getNumber(
        rawProfile.values,
        "LLM_FALLBACK_TIMEOUT_MS",
        defaults.llmFallbackTimeoutMs
      ),
      llmFallbackDailyBudgetUsd: getNumber(
        rawProfile.values,
        "LLM_FALLBACK_DAILY_BUDGET_USD",
        defaults.llmFallbackDailyBudgetUsd
      )
    },
    plans: [
      {
        id: "free",
        displayName: "Free",
        monthlyPrice: "$0",
        yearlyPrice: "$0",
        monthlyImports: freeLifetimeImports,
        monthlyStrongExtractions: freeLifetimeImports,
        savedRecipes: formatSavedRecipeLimit(15)
      },
      {
        id: "plus",
        displayName: "LinkDish Plus",
        monthlyPrice: extractorApiEnv.PLUS_MONTHLY_PRICE_LABEL,
        yearlyPrice: extractorApiEnv.PLUS_YEARLY_PRICE_LABEL,
        monthlyImports: plusMonthlyImports,
        monthlyStrongExtractions: plusMonthlyImports,
        savedRecipes: formatSavedRecipeLimit(null)
      },
      {
        id: "family",
        displayName: "LinkDish Family",
        monthlyPrice: extractorApiEnv.FAMILY_MONTHLY_PRICE_LABEL,
        yearlyPrice: extractorApiEnv.FAMILY_YEARLY_PRICE_LABEL,
        monthlyImports: familyMonthlyImports,
        monthlyStrongExtractions: familyMonthlyImports,
        savedRecipes: formatSavedRecipeLimit(null)
      }
    ],
    notes
  };
};
