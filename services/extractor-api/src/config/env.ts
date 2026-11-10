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
  loadDotEnv({ path, quiet: true });
}

const trimmedString = () => z.string().trim();
const trimmedOptionalString = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === "" ? undefined : value));
const optionalPositiveIntegerString = () =>
  trimmedOptionalString()
    .transform((value) => (value === undefined ? undefined : Number(value)))
    .pipe(z.number().int().positive().optional());
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
    /*
     * Connection-error retries for the HTTP fetch. The fetcher caps this at 1
     * (larger legacy values are accepted and clamped), and skips retries when
     * the browser fetcher can take over.
     */
    FETCH_HTTP_RETRIES: z.coerce.number().int().min(0).default(1),
    /* One deadline for the whole /extract request; kept below the function's maxDuration (60 s). */
    EXTRACT_REQUEST_DEADLINE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(50_000)
      .transform((value) => Math.min(Math.max(value, 5_000), 55_000)),
    /* Kill switch for the URL-keyed extraction result cache. */
    EXTRACT_CACHE_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /* Result cache lifetime, clamped to 1 minute .. 30 days (default 7 days). */
    EXTRACT_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60)
      .transform((value) => Math.min(Math.max(value, 60), 30 * 24 * 60 * 60)),
    /*
     * Gemini text cleanup of successful imports. Even when enabled it only runs
     * when the text shows artifacts and an LLM provider is active (not "none").
     */
    RECIPE_TEXT_CLEANUP_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    FETCH_MAX_RESPONSE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    BROWSER_FETCH_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    BROWSER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    BROWSER_FETCH_CONCURRENCY: z.coerce.number().int().positive().default(2),
    /*
     * Obey each site's robots.txt (RFC 9309) for the LinkDishBot user-agent before every request
     * to a site people import from (fetchers/robots-txt.ts). On by default; turning it off needs a
     * reason a lawyer has agreed with.
     */
    ROBOTS_TXT_ENFORCED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * Platform paths, each checked against that platform's own terms on 2026-11-08 (see
     * outputs/CONTENT-RIGHTS-REVIEW.md). That review found the YouTube, Instagram, Facebook and
     * Pinterest terms, and TikTok's terms on video downloads, do not permit LinkDish's automated
     * reading without the platform's written permission, and these paths were turned off by
     * default. On 2026-11-08 Robert decided to turn them back on by default, accepting that risk
     * (including Apple guidelines 5.2.2 and 5.2.3). Each flag still turns its path off on its own:
     * set it to "false".
     *
     * TikTok captions through TikTok's public, documented oEmbed endpoint: on by default (the
     * endpoint is published for developers; whether its use for import is covered is still open).
     */
    TIKTOK_IMPORT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * YouTube watch pages and the youtubei comments endpoint. YouTube's terms bar automated access;
     * on by default since Robert's 2026-11-08 decision to accept that risk.
     */
    YOUTUBE_IMPORT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * Instagram embed pages in the headless browser. Instagram's terms bar automated collection;
     * on by default since Robert's 2026-11-08 decision to accept that risk.
     */
    INSTAGRAM_IMPORT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * Facebook public post pages. Facebook's terms bar automated collection without permission;
     * on by default since Robert's 2026-11-08 decision to accept that risk.
     */
    FACEBOOK_IMPORT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * Pinterest pin pages (to follow the pin's link). Pinterest's terms bar automated access; on
     * by default since Robert's 2026-11-08 decision to accept that risk.
     */
    PINTEREST_IMPORT_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    /*
     * Downloading TikTok and Facebook video files for the video reader. TikTok's terms bar
     * downloads without consent, and Apple guideline 5.2.3 asks for explicit authorization to
     * download media from third-party sources. On by default since Robert's 2026-11-08 decision
     * to accept that risk. Downloads only happen while the video reader is on too
     * (VIDEO_RECIPE_READER_ENABLED and GEMINI_API_KEY). YouTube is never downloaded (Gemini reads
     * it by URL).
     */
    SOCIAL_VIDEO_DOWNLOAD_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    LLM_PROVIDER: trimmedString()
      .pipe(z.enum(["gemini", "openai", "none"]))
      .default("none"),
    GEMINI_API_KEY: trimmedOptionalString(),
    GEMINI_MODEL: trimmedOptionalString(),
    OPENAI_API_KEY: trimmedOptionalString(),
    OPENAI_MODEL: trimmedOptionalString(),
    LLM_FALLBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /*
     * Gemini watches a TikTok, Facebook or YouTube video when its caption, description and linked
     * pages hold no written recipe. It needs GEMINI_API_KEY too. On by default since 2026-11-08
     * (off before): the TikTok and Facebook video downloads that SOCIAL_VIDEO_DOWNLOAD_ENABLED
     * allows only feed this reader, so with the reader off, Robert's 2026-11-08 decision to turn
     * those downloads back on would have no effect. Reads are capped by
     * VIDEO_RECIPE_DAILY_READ_LIMIT. Set to "false" to turn the reader, and with it every video
     * download, off.
     */
    VIDEO_RECIPE_READER_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("true")
      .transform((value) => value === true || value === "true"),
    VIDEO_RECIPE_MODEL: trimmedString().default("gemini-3.8-flash"),
    /* Gemini model that fills a saved recipe's gaps when the person asks (POST /recipes/complete). */
    RECIPE_COMPLETION_MODEL: trimmedString().default("gemini-3.8-flash"),
    /* Longer videos are not sent: they cost more and cannot be read inside the request deadline. */
    VIDEO_RECIPE_MAX_SECONDS: z.coerce.number().int().positive().default(240),
    VIDEO_RECIPE_TIMEOUT_MS: z.coerce.number().int().positive().default(40_000),
    /*
     * Gemini video reads per UTC day, across instances with Upstash (per instance without); 0
     * stops them. Bounds the reader's spend.
     */
    VIDEO_RECIPE_DAILY_READ_LIMIT: z.coerce.number().int().nonnegative().default(300),
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
    LIBRARY_SYNC_ENABLED: z
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
    /*
     * Sign in with Apple token revocation on account deletion. All four are needed; until they
     * are set, a deletion carries on and tells the person to turn off "Sign in with Apple" for
     * LinkDish in their Apple Account settings themselves.
     * APPLE_SIGN_IN_CLIENT_ID is the iOS app's bundle ID (the client the authorization code was
     * issued to), and APPLE_SIGN_IN_PRIVATE_KEY the Sign in with Apple .p8 key's contents
     * (newlines may be written as \n).
     */
    APPLE_SIGN_IN_TEAM_ID: trimmedOptionalString(),
    APPLE_SIGN_IN_KEY_ID: trimmedOptionalString(),
    APPLE_SIGN_IN_PRIVATE_KEY: trimmedOptionalString(),
    APPLE_SIGN_IN_CLIENT_ID: trimmedOptionalString(),
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
    ADMIN_DASHBOARD_TOKENS: trimmedOptionalString(),
    ADMIN_AUTH_FAILURE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    ADMIN_AUTH_FAILURE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    // The privacy policy keeps server logs for up to 90 days; this log is one of them.
    ADMIN_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    ANALYTICS_ENABLED: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    ANALYTICS_DATABASE_URL: trimmedOptionalString().pipe(z.string().url().optional()),
    ANALYTICS_HASH_SECRET: trimmedOptionalString(),
    ANALYTICS_DATABASE_CA_CERT: trimmedOptionalString(),
    ANALYTICS_DATABASE_ALLOW_INSECURE_TLS: z
      .union([trimmedBooleanString, z.boolean()])
      .default("false")
      .transform((value) => value === true || value === "true"),
    // Unset means analytics are kept indefinitely; the daily purge only runs for a table group
    // whose retention is set.
    ANALYTICS_RETENTION_DAYS: optionalPositiveIntegerString(),
    ANALYTICS_ROLLUP_RETENTION_DAYS: optionalPositiveIntegerString(),
    CRON_SECRET: trimmedOptionalString(),
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
