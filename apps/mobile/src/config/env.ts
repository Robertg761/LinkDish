import { readEnv, stringBooleanSchema } from "@linkdish/config";
import { z } from "zod";

const readOptionalPublicEnv = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const csvStringSchema = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );

const explicitApiBaseUrl = readOptionalPublicEnv(process.env.EXPO_PUBLIC_API_BASE_URL);

const rawEnv = readEnv(
  {
    EXPO_PUBLIC_USE_MOCK_API: z.enum(["true", "false"]).default("false").pipe(stringBooleanSchema),
    EXPO_PUBLIC_API_BASE_URL: z.string().url().default("https://api.linkdish.ca"),
    EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR: z
      .enum(["true", "false"])
      .default("false")
      .pipe(stringBooleanSchema),
    EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW: z
      .enum(["true", "false"])
      .default("false")
      .pipe(stringBooleanSchema),
    EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: z.string().optional(),
    EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: z.string().optional(),
    EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID: z.string().default("Plus"),
    EXPO_PUBLIC_REVENUECAT_PLUS_ENTITLEMENT_ID: z.string().optional(),
    EXPO_PUBLIC_REVENUECAT_FAMILY_ENTITLEMENT_ID: z.string().default("Family"),
    EXPO_PUBLIC_REVENUECAT_PLUS_PRODUCT_IDS: csvStringSchema("linkdish_plus"),
    EXPO_PUBLIC_REVENUECAT_FAMILY_PRODUCT_IDS: csvStringSchema("linkdish_family"),
    EXPO_PUBLIC_REVENUECAT_OFFERING_ID: z.string().optional()
  },
  {
    EXPO_PUBLIC_API_BASE_URL: explicitApiBaseUrl,
    EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR
    ),
    EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW
    ),
    EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY
    ),
    EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID
    ),
    EXPO_PUBLIC_REVENUECAT_FAMILY_ENTITLEMENT_ID: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_FAMILY_ENTITLEMENT_ID
    ),
    EXPO_PUBLIC_REVENUECAT_FAMILY_PRODUCT_IDS: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_FAMILY_PRODUCT_IDS
    ),
    EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY
    ),
    EXPO_PUBLIC_REVENUECAT_OFFERING_ID: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_OFFERING_ID
    ),
    EXPO_PUBLIC_REVENUECAT_PLUS_ENTITLEMENT_ID: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_PLUS_ENTITLEMENT_ID
    ),
    EXPO_PUBLIC_REVENUECAT_PLUS_PRODUCT_IDS: readOptionalPublicEnv(
      process.env.EXPO_PUBLIC_REVENUECAT_PLUS_PRODUCT_IDS
    ),
    EXPO_PUBLIC_USE_MOCK_API: readOptionalPublicEnv(process.env.EXPO_PUBLIC_USE_MOCK_API)
  }
);

const localDevelopmentApiBaseUrl = "http://localhost:3000";
const shouldUseConfiguredApiBaseUrl =
  Boolean(explicitApiBaseUrl) || process.env.NODE_ENV === "production";
const apiBaseUrl = shouldUseConfiguredApiBaseUrl
  ? rawEnv.EXPO_PUBLIC_API_BASE_URL
  : localDevelopmentApiBaseUrl;

export const mobileEnv = {
  useMockApi: rawEnv.EXPO_PUBLIC_USE_MOCK_API,
  apiBaseUrl,
  debugHouseholdSimulatorEnabled:
    process.env.NODE_ENV !== "production" && rawEnv.EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR,
  localPlanPreviewEnabled:
    process.env.NODE_ENV !== "production" && rawEnv.EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW,
  revenueCatAndroidApiKey: rawEnv.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
  revenueCatEntitlementIds: {
    plus:
      rawEnv.EXPO_PUBLIC_REVENUECAT_PLUS_ENTITLEMENT_ID ??
      rawEnv.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID,
    family: rawEnv.EXPO_PUBLIC_REVENUECAT_FAMILY_ENTITLEMENT_ID
  },
  revenueCatProductIds: {
    plus: rawEnv.EXPO_PUBLIC_REVENUECAT_PLUS_PRODUCT_IDS,
    family: rawEnv.EXPO_PUBLIC_REVENUECAT_FAMILY_PRODUCT_IDS
  },
  revenueCatIosApiKey: rawEnv.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
  revenueCatOfferingId: rawEnv.EXPO_PUBLIC_REVENUECAT_OFFERING_ID
};
