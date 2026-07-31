import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

import { readEnv } from "../../../../packages/config/src/index.js";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localEnvironmentFile =
  process.env.VERCEL_ENV === "production" ? ".env.production.local" : ".env.development.local";

for (const path of [
  resolve(serviceRoot, localEnvironmentFile),
  resolve(serviceRoot, ".env.local"),
  resolve(process.cwd(), ".env")
]) {
  loadDotEnv({ path });
}

const trimmedString = () => z.string().trim();
const trimmedOptionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value));
const trimmedBooleanString = z
  .string()
  .trim()
  .pipe(z.union([z.literal("true"), z.literal("false")]));

const parsedExtractorApiEnv = readEnv(
  {
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ORIGIN: trimmedString().default("*"),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    FETCH_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    FETCH_HTTP_RETRIES: z.coerce.number().int().min(0).default(2),
    BROWSER_FETCH_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    BROWSER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    BROWSER_FETCH_CONCURRENCY: z.coerce.number().int().positive().default(2),
    LLM_PROVIDER: trimmedString()
      .pipe(z.enum(["gemini", "openai", "none"]))
      .default("none"),
    GEMINI_API_KEY: trimmedOptionalString(),
    GEMINI_MODEL: trimmedOptionalString(),
    OPENAI_API_KEY: trimmedOptionalString(),
    OPENAI_MODEL: trimmedOptionalString(),
    LLM_FALLBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    LLM_FALLBACK_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(0),
    BILLING_ENFORCEMENT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    REVENUECAT_SECRET_API_KEY: trimmedOptionalString(),
    REVENUECAT_V2_SECRET_API_KEY: trimmedOptionalString(),
    REVENUECAT_PROJECT_ID: trimmedOptionalString(),
    REVENUECAT_WEBHOOK_AUTHORIZATION: trimmedOptionalString(),
    REVENUECAT_WEBHOOK_SIGNING_SECRET: trimmedOptionalString(),
    REVENUECAT_ENTITLEMENT_ID: trimmedString().default("Plus"),
    REVENUECAT_PLUS_ENTITLEMENT_ID: trimmedOptionalString(),
    REVENUECAT_FAMILY_ENTITLEMENT_ID: trimmedString().default("Family"),
    WEB_BILLING_CHECKOUT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    REVENUECAT_WEB_PURCHASE_LINK_PLUS_MONTHLY: trimmedOptionalString().pipe(
      z.string().url().optional()
    ),
    REVENUECAT_WEB_PURCHASE_LINK_PLUS_YEARLY: trimmedOptionalString().pipe(
      z.string().url().optional()
    ),
    REVENUECAT_WEB_PURCHASE_LINK_FAMILY_MONTHLY: trimmedOptionalString().pipe(
      z.string().url().optional()
    ),
    REVENUECAT_WEB_PURCHASE_LINK_FAMILY_YEARLY: trimmedOptionalString().pipe(
      z.string().url().optional()
    ),
    REVENUECAT_WEB_PURCHASE_LINK_FOUNDING_LIFETIME: trimmedOptionalString().pipe(
      z.string().url().optional()
    ),
    FOUNDING_LIFETIME_PRICE_LABEL: trimmedString().default("$29.99"),
    REVENUECAT_WEB_MANAGEMENT_URL: trimmedOptionalString().pipe(z.string().url().optional()),
    BILLING_QUOTA_IDENTITY_SECRET: trimmedOptionalString(),
    LINKDISH_CANARY_TOKEN: trimmedOptionalString(),
    LINKDISH_MONTHLY_METERING: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    FREE_LIFETIME_IMPORT_LIMIT: z.coerce.number().int().nonnegative().default(3),
    FREE_MONTHLY_IMPORT_LIMIT: z.coerce.number().int().nonnegative().default(5),
    PLUS_MONTHLY_IMPORT_LIMIT: z.coerce.number().int().nonnegative().default(100),
    FAMILY_MONTHLY_IMPORT_LIMIT: z.coerce.number().int().nonnegative().default(250),
    PLUS_MONTHLY_PRICE_LABEL: trimmedString().default("$2.99"),
    PLUS_YEARLY_PRICE_LABEL: trimmedString().default("$24.99"),
    FAMILY_MONTHLY_PRICE_LABEL: trimmedString().default("$4.99"),
    FAMILY_YEARLY_PRICE_LABEL: trimmedString().default("$44.99"),
    LINKDISH_TEST_PREMIUM_USER_IDS: trimmedOptionalString(),
    LINKDISH_TEST_PREMIUM_PLAN_ID: z.enum(["plus", "family"]).default("family"),
    AUTH_MODE: z
      .enum(["legacy_email_code", "clerk_beta", "clerk_primary"])
      .default("legacy_email_code"),
    HOUSEHOLDS_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    AUTH_SECRET: trimmedOptionalString(),
    AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    AUTH_LOGIN_CODE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(600_000),
    AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(7_776_000),
    APP_REVIEW_LOGIN_EMAILS: trimmedOptionalString(),
    APP_REVIEW_LOGIN_CODE: trimmedOptionalString(),
    CLERK_SECRET_KEY: trimmedOptionalString(),
    CLERK_JWT_AUDIENCE: trimmedOptionalString(),
    CLERK_AUTHORIZED_PARTIES: trimmedOptionalString(),
    CLERK_JWT_KEY: trimmedOptionalString(),
    CLERK_WEBHOOK_SECRET: trimmedOptionalString(),
    HOUSEHOLD_INVITE_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
    HOUSEHOLD_MEMBER_LIMIT: z.coerce.number().int().positive().default(6),
    HOUSEHOLD_REPLACEMENT_COOLDOWN_DAYS: z.coerce.number().int().nonnegative().default(30),
    LINKDISH_PUBLIC_SITE_URL: trimmedOptionalString().pipe(z.string().url().optional()),
    RESEND_API_KEY: trimmedOptionalString(),
    AUTH_EMAIL_FROM: trimmedOptionalString(),
    IOS_WAITLIST_EMAIL_FROM: trimmedOptionalString(),
    UPSTASH_REDIS_REST_URL: trimmedOptionalString().pipe(z.string().url().optional()),
    UPSTASH_REDIS_REST_TOKEN: trimmedOptionalString(),
    NODE_ENV: trimmedString().default("development"),
    ADMIN_DASHBOARD_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    ADMIN_DASHBOARD_TOKEN: trimmedOptionalString(),
    ANALYTICS_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    ANALYTICS_DATABASE_URL: trimmedOptionalString().pipe(z.string().url().optional()),
    ANALYTICS_HASH_SECRET: trimmedOptionalString(),
    ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
    ANALYTICS_ROLLUP_RETENTION_DAYS: z.coerce.number().int().positive().default(1095),
    GOOGLE_PLAY_PACKAGE_NAME: trimmedString().default("com.linkdish.app"),
    VERCEL_API_TOKEN: trimmedOptionalString(),
    VERCEL_PROJECT_ID: trimmedOptionalString(),
    VERCEL_TEAM_ID: trimmedOptionalString()
  },
  process.env
);

export const extractorApiEnv = {
  ...parsedExtractorApiEnv,
  REVENUECAT_PLUS_ENTITLEMENT_ID:
    parsedExtractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID ??
    parsedExtractorApiEnv.REVENUECAT_ENTITLEMENT_ID
};

if (
  extractorApiEnv.NODE_ENV === "production" &&
  extractorApiEnv.HOUSEHOLDS_ENABLED &&
  (!extractorApiEnv.AUTH_SECRET ||
    !extractorApiEnv.RESEND_API_KEY ||
    !extractorApiEnv.AUTH_EMAIL_FROM)
) {
  throw new Error(
    "HOUSEHOLDS_ENABLED requires AUTH_SECRET, RESEND_API_KEY, and AUTH_EMAIL_FROM in production."
  );
}

if (
  extractorApiEnv.NODE_ENV === "production" &&
  extractorApiEnv.AUTH_MODE !== "legacy_email_code" &&
  (!extractorApiEnv.CLERK_SECRET_KEY || !extractorApiEnv.CLERK_WEBHOOK_SECRET)
) {
  throw new Error(
    "Clerk auth modes require CLERK_SECRET_KEY and CLERK_WEBHOOK_SECRET in production."
  );
}
