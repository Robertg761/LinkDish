import { z } from "zod";

import {
  buildPinnedHttpUrlSchema,
  httpUrlSchema,
  missingRecipeFieldSchema,
  recipeSchema,
  shoppingItemSchema,
  sourceTypeSchema
} from "../../recipe-domain/src/index.js";

/** Hosts LinkDish itself serves. Used to pin URLs the clients follow automatically. */
export const LINKDISH_HOSTS = [
  "linkdish.ca",
  "linkdish.xyz",
  "linkdish.app",
  "linkdish-web.vercel.app",
  "linkdish-api.vercel.app",
  "localhost",
  "127.0.0.1"
] as const;

/** Billing providers the checkout/portal redirects are allowed to point at. */
export const BILLING_REDIRECT_HOSTS = [
  ...LINKDISH_HOSTS,
  "revenuecat.com",
  "rev.cat",
  "stripe.com"
] as const;

export const MAX_IMAGE_DATA_URL_CHARS = 4_500_000;
export const MAX_IMAGE_EXTRACT_PAYLOAD_CHARS = 8_000_000;
export const MAX_IMAGE_EXTRACT_COUNT = 4;

const imageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
const imageDataUrlSchema = z
  .string()
  .min(1)
  .max(MAX_IMAGE_DATA_URL_CHARS)
  .regex(/^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=\s]+$/iu);
const extractionCorrelationIdSchema = z.string().uuid();

export const extractRecipeImageSchema = z.object({
  dataUrl: imageDataUrlSchema,
  mimeType: imageMimeTypeSchema
});

/**
 * Measures an image extraction payload without serializing it. `JSON.stringify` on an 18 MB
 * payload just to learn that it is too big is exactly what this guard exists to avoid.
 */
const measureImageExtractPayloadChars = (payload: unknown): number => {
  if (!payload || typeof payload !== "object") {
    return 0;
  }

  const { images } = payload as { images?: unknown };

  if (!Array.isArray(images)) {
    return 0;
  }

  let total = 0;

  for (const image of images) {
    if (image && typeof image === "object") {
      const { dataUrl } = image as { dataUrl?: unknown };

      if (typeof dataUrl === "string") {
        total += dataUrl.length;
      }
    }
  }

  return total;
};

const extractRecipeUrlRequestSchema = z.object({
  url: httpUrlSchema,
  attempt: z.enum(["primary", "fallback"]).default("primary"),
  correlationId: extractionCorrelationIdSchema.optional()
});

const extractRecipeImageRequestObjectSchema = z.object({
  images: z.array(extractRecipeImageSchema).min(1).max(MAX_IMAGE_EXTRACT_COUNT),
  sourceUrl: httpUrlSchema,
  attempt: z.literal("fallback").default("fallback"),
  correlationId: extractionCorrelationIdSchema.optional()
});

// The size guard runs *before* the object (and therefore before the per-image base64 regex), so an
// oversized payload is rejected without megabytes of regex scanning or re-serialization.
const extractRecipeImageRequestSchema = z
  .unknown()
  .superRefine((payload, context) => {
    if (measureImageExtractPayloadChars(payload) > MAX_IMAGE_EXTRACT_PAYLOAD_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message: "Image extraction payload is too large."
      });
    }
  })
  .pipe(extractRecipeImageRequestObjectSchema);

export const extractRecipeRequestSchema = z.union([
  extractRecipeImageRequestSchema,
  extractRecipeUrlRequestSchema
]);

export const MIN_EXTRACT_TEXT_CHARS = 20;
export const MAX_EXTRACT_TEXT_CHARS = 20_000;

/**
 * Pasted recipe text (a caption, a note, an email). It always goes to the AI extractor, so it
 * is metered like an explicit fallback attempt whatever `attempt` says; `attempt` is accepted
 * (and defaults to "fallback") so callers can reuse their URL request plumbing.
 */
export const extractRecipeTextRequestSchema = z.object({
  text: z.string().trim().min(MIN_EXTRACT_TEXT_CHARS).max(MAX_EXTRACT_TEXT_CHARS),
  sourceUrl: httpUrlSchema.optional(),
  attempt: z.enum(["primary", "fallback"]).default("fallback"),
  correlationId: extractionCorrelationIdSchema.optional()
});

/**
 * Every request shape POST /extract accepts: image scans, URLs and pasted text. The
 * `ExtractRecipeRequest` type stays the image/URL union that existing callers narrow with
 * `"images" in request` / `request.url`; text requests have their own type and client method.
 */
export const extractRecipeAnyRequestSchema = z.union([
  extractRecipeImageRequestSchema,
  extractRecipeUrlRequestSchema,
  extractRecipeTextRequestSchema
]);

export const extractionStrategySchema = z.enum([
  "recipe-schema",
  "recipe-adapter-dom",
  "article-pattern",
  "youtube-transcript",
  "llm-fallback"
]);

export const recoverySchema = z.object({
  retryable: z.boolean(),
  allowFallback: z.boolean(),
  suggestedAction: z.enum(["retry_primary", "retry_fallback", "try_another_url", "try_again_later"])
});

export const quotaMeteringModeSchema = z.enum([
  "disabled",
  "free_lifetime",
  "free_monthly_grandfathered",
  "paid_monthly",
  "unknown"
]);

export const quotaStatusSchema = z.object({
  limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  monthlyLimit: z.number().int().nonnegative().nullable(),
  remainingThisMonth: z.number().int().nonnegative().nullable(),
  resetsAt: z.string().datetime().nullable(),
  meteringMode: quotaMeteringModeSchema
});

/** GET /billing/usage: the caller's current import allowance, without counting an import. */
export const billingUsageResponseSchema = z.object({
  billingEnabled: z.boolean(),
  plan: z.enum(["free", "plus", "family"]).nullable(),
  quota: quotaStatusSchema.nullable()
});

export const fetchModeSchema = z.enum(["http", "browser"]);
export const extractionProvenanceSchema = z.enum([
  "jsonld",
  "microdata",
  "readability",
  "visible-text",
  "transcript",
  "llm"
]);

export const extractRecipeSuccessSchema = z.object({
  status: z.literal("success"),
  recipe: recipeSchema,
  extraction: z.object({
    sourceType: sourceTypeSchema,
    strategy: extractionStrategySchema,
    confidenceScore: z.number().min(0).max(1),
    missingFields: z.array(missingRecipeFieldSchema),
    warnings: z.array(z.string().min(1)),
    fetchMode: fetchModeSchema,
    provenance: z.array(extractionProvenanceSchema)
  }),
  // Optional, additive: the caller's allowance after this import was counted. Absent when
  // billing is disabled or for callers that are not metered.
  quota: quotaStatusSchema.optional()
});

export const extractRecipeNeedsRetrySchema = z.object({
  status: z.literal("needs_retry"),
  reason: z.enum([
    "low_confidence",
    "missing_required_fields",
    "transcript_required",
    "unsupported_primary_extraction"
  ]),
  sourceType: sourceTypeSchema,
  suggestedAttempt: z.literal("fallback"),
  userMessage: z.string().min(1),
  diagnostics: z.object({
    confidenceScore: z.number().min(0).max(1),
    missingFields: z.array(missingRecipeFieldSchema)
  }),
  recovery: recoverySchema.optional()
});

export const extractRecipeFailureSchema = z.object({
  status: z.literal("failure"),
  reason: z.enum([
    "unsupported_source",
    "source_unreachable",
    "source_blocked",
    "timeout",
    "parse_failed",
    "fallback_unavailable",
    "fallback_failed",
    "quota_exceeded",
    "plan_limit"
  ]),
  userMessage: z.string().min(1),
  recovery: recoverySchema.optional(),
  quota: quotaStatusSchema.optional()
});

export const extractRecipeResponseSchema = z.discriminatedUnion("status", [
  extractRecipeSuccessSchema,
  extractRecipeNeedsRetrySchema,
  extractRecipeFailureSchema
]);

export type ExtractRecipeRequest = z.infer<typeof extractRecipeRequestSchema>;
export type ExtractRecipeTextRequest = z.infer<typeof extractRecipeTextRequestSchema>;
export type ExtractRecipeTextRequestInput = z.input<typeof extractRecipeTextRequestSchema>;
export type ExtractRecipeAnyRequest = z.infer<typeof extractRecipeAnyRequestSchema>;
export type ExtractRecipeImage = z.infer<typeof extractRecipeImageSchema>;
export type ExtractRecipeResponse = z.infer<typeof extractRecipeResponseSchema>;
export type ExtractRecipeSuccess = z.infer<typeof extractRecipeSuccessSchema>;
export type ExtractRecipeNeedsRetry = z.infer<typeof extractRecipeNeedsRetrySchema>;
export type ExtractRecipeFailure = z.infer<typeof extractRecipeFailureSchema>;
export type QuotaMeteringMode = z.infer<typeof quotaMeteringModeSchema>;
export type QuotaStatus = z.infer<typeof quotaStatusSchema>;
export type BillingUsageResponse = z.infer<typeof billingUsageResponseSchema>;
export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>;
export type Recovery = z.infer<typeof recoverySchema>;
export type FetchMode = z.infer<typeof fetchModeSchema>;
export type ExtractionProvenance = z.infer<typeof extractionProvenanceSchema>;

const unsafeProfileDisplayNamePattern =
  /(?:[\p{Cc}\p{Cs}\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]|\u034F)/u;
const singleProfileAvatarEmojiPattern =
  /^(?:\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:[\u{1F3FB}-\u{1F3FF}])?)*|[\p{Regional_Indicator}]{2}|[#*0-9]\uFE0F?\u20E3)$/u;

export const accountProfileDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(
    (value) => !unsafeProfileDisplayNamePattern.test(value),
    "Profile display name cannot include control or invisible characters."
  );
export const accountProfileAvatarEmojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .emoji("Profile avatar must be a single emoji.")
  .refine(
    (value) => singleProfileAvatarEmojiPattern.test(value),
    "Profile avatar must be a single emoji."
  );

const emptyProfileStringToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? null : value;

const accountProfileDisplayNameInputSchema = z.preprocess(
  emptyProfileStringToNull,
  accountProfileDisplayNameSchema.nullable()
);
const accountProfileAvatarEmojiInputSchema = z.preprocess(
  emptyProfileStringToNull,
  accountProfileAvatarEmojiSchema.nullable()
);

export const accountBillingPlanSchema = z.enum(["free", "plus", "family"]);
export const paidBillingPlanSchema = z.enum(["plus", "family"]);
export const billingPeriodSchema = z.enum(["monthly", "yearly"]);

export const accountUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  billingPlan: accountBillingPlanSchema.optional(),
  displayName: accountProfileDisplayNameSchema.nullable().optional(),
  avatarEmoji: accountProfileAvatarEmojiSchema.nullable().optional()
});

export const updateAccountProfileRequestSchema = z
  .object({
    displayName: accountProfileDisplayNameInputSchema.optional(),
    avatarEmoji: accountProfileAvatarEmojiInputSchema.optional()
  })
  .refine(
    (profile) => profile.displayName !== undefined || profile.avatarEmoji !== undefined,
    "Profile update must include a display name or emoji."
  );

export const updateAccountProfileResponseSchema = z.object({
  user: accountUserSchema
});

export const requestLoginCodeRequestSchema = z.object({
  email: z.string().trim().email()
});

export const requestLoginCodeResponseSchema = z.object({
  status: z.literal("sent"),
  email: z.string().email(),
  expiresInSeconds: z.number().int().positive()
});

export const verifyLoginCodeRequestSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().regex(/^\d{6}$/u),
  displayName: accountProfileDisplayNameInputSchema.optional(),
  avatarEmoji: accountProfileAvatarEmojiInputSchema.optional()
});

export const verifyLoginCodeResponseSchema = z.object({
  status: z.literal("authenticated"),
  sessionToken: z.string().min(24),
  user: accountUserSchema,
  expiresAt: z.string().datetime()
});

export const authSessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({
    authenticated: z.literal(true),
    user: accountUserSchema,
    expiresAt: z.string().datetime()
  }),
  z.object({
    authenticated: z.literal(false)
  })
]);

export const authModeSchema = z.enum(["legacy_email_code", "clerk_beta", "clerk_primary"]);

export const authConfigResponseSchema = z.object({
  authMode: authModeSchema,
  clerkEnabled: z.boolean(),
  emailCodeEnabled: z.boolean()
});

export const webBillingAvailabilitySchema = z.object({
  managementPortalAvailable: z.boolean(),
  plans: z.object({
    family: z.object({
      monthly: z.boolean(),
      yearly: z.boolean()
    }),
    plus: z.object({
      monthly: z.boolean(),
      yearly: z.boolean()
    })
  }),
  prices: z.object({
    family: z.object({
      monthly: z.string().min(1),
      yearly: z.string().min(1)
    }),
    plus: z.object({
      monthly: z.string().min(1),
      yearly: z.string().min(1)
    })
  }),
  // Optional, additive founding lifetime offer. Absent for clients/backends that predate the
  // Founding Plus offer, and only present once the RevenueCat Web Purchase Link is configured.
  founding: z
    .object({
      available: z.boolean(),
      priceLabel: z.string().min(1)
    })
    .optional(),
  webCheckoutEnabled: z.boolean()
});

export const createWebBillingCheckoutRequestSchema = z.union([
  z.object({
    period: billingPeriodSchema,
    plan: paidBillingPlanSchema
  }),
  z.object({
    offer: z.literal("founding")
  })
]);

export const webBillingRedirectResponseSchema = z.object({
  // The web app assigns this straight to `window.location`, so it is pinned to LinkDish and the
  // billing providers rather than being any URL the API happens to return.
  url: buildPinnedHttpUrlSchema(BILLING_REDIRECT_HOSTS, "Billing redirect URL host is not allowed.")
});

export const logoutResponseSchema = z.object({
  status: z.literal("logged_out")
});

export const deleteAccountRequestSchema = z.object({
  confirmEmail: z.string().trim().email()
});

export const deleteAccountResponseSchema = z.object({
  status: z.literal("deleted")
});

export const householdMemberSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  displayName: accountProfileDisplayNameSchema.nullable().optional(),
  avatarEmoji: accountProfileAvatarEmojiSchema.nullable().optional(),
  role: z.enum(["owner", "member"]),
  joinedAt: z.string().datetime()
});

export const householdInviteSummarySchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  expiresAt: z.string().datetime()
});

export const householdInviteCodeSchema = z.string().trim().min(8).max(120);

export const householdInviteShareSchema = householdInviteSummarySchema.extend({
  inviteCode: householdInviteCodeSchema,
  inviteUrl: buildPinnedHttpUrlSchema(LINKDISH_HOSTS, "Invite URL host is not allowed.")
});

export const householdDetailsSchema = z.object({
  id: z.string().min(1),
  ownerUserId: z.string().min(1),
  role: z.enum(["owner", "member"]),
  memberLimit: z.number().int().positive(),
  activeMemberCount: z.number().int().nonnegative(),
  cooldownSlotCount: z.number().int().nonnegative(),
  ownerFamilyEntitlementActive: z.boolean(),
  members: z.array(householdMemberSchema),
  invites: z.array(householdInviteSummarySchema)
});

export const householdSummarySchema = z.object({
  household: householdDetailsSchema.nullable()
});

export const createHouseholdResponseSchema = z.object({
  household: householdDetailsSchema
});

export const createInviteRequestSchema = z.object({
  email: z.string().trim().email()
});

export const createInviteResponseSchema = z.object({
  invite: householdInviteShareSchema,
  household: householdDetailsSchema
});

export const cancelInviteRequestSchema = z.object({
  inviteId: z.string().min(1)
});

export const acceptInviteRequestSchema = z.object({
  inviteCode: householdInviteCodeSchema
});

export const acceptInviteResponseSchema = z.object({
  household: householdDetailsSchema
});

export const removeHouseholdMemberRequestSchema = z.object({
  userId: z.string().min(1)
});

export const householdMutationResponseSchema = z.object({
  household: householdDetailsSchema.nullable()
});

export const MAX_SHARED_RECIPE_PAYLOAD_CHARS = 120_000;
const MAX_SHARED_RECIPE_SOURCE_ID_LENGTH = 180;
const MAX_SHARED_RECIPE_NOTES_LENGTH = 5_000;
const MAX_SHARED_RECIPE_WARNING_COUNT = 50;
const MAX_SHARED_RECIPE_WARNING_LENGTH = 500;

const sharedRecipeSourceSavedRecipeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SHARED_RECIPE_SOURCE_ID_LENGTH);
const sharedRecipeNotesSchema = z.string().max(MAX_SHARED_RECIPE_NOTES_LENGTH);
const sharedRecipeWarningsSchema = z
  .array(z.string().max(MAX_SHARED_RECIPE_WARNING_LENGTH))
  .max(MAX_SHARED_RECIPE_WARNING_COUNT);

const addSharedRecipePayloadLimitIssue = (payload: unknown, context: z.RefinementCtx): void => {
  if (JSON.stringify(payload).length > MAX_SHARED_RECIPE_PAYLOAD_CHARS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Shared recipe payload is too large."
    });
  }
};

export const sharedRecipeSchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  ownerUserId: z.string().min(1),
  ownerEmail: z.string().email(),
  ownerDisplayName: accountProfileDisplayNameSchema.nullable().optional(),
  ownerAvatarEmoji: accountProfileAvatarEmojiSchema.nullable().optional(),
  sourceSavedRecipeId: sharedRecipeSourceSavedRecipeIdSchema.optional(),
  recipe: recipeSchema,
  notes: sharedRecipeNotesSchema.optional(),
  fetchMode: fetchModeSchema,
  provenance: z.array(extractionProvenanceSchema),
  strategy: extractionStrategySchema,
  warnings: sharedRecipeWarningsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const sharedRecipeListResponseSchema = z.object({
  recipes: z.array(sharedRecipeSchema)
});

const upsertSharedRecipeRequestBaseSchema = z.object({
  sourceSavedRecipeId: sharedRecipeSourceSavedRecipeIdSchema.optional(),
  recipe: recipeSchema,
  notes: sharedRecipeNotesSchema.nullable().optional(),
  fetchMode: fetchModeSchema,
  provenance: z.array(extractionProvenanceSchema),
  strategy: extractionStrategySchema,
  warnings: sharedRecipeWarningsSchema.default([])
});

export const upsertSharedRecipeRequestSchema = upsertSharedRecipeRequestBaseSchema.superRefine(
  addSharedRecipePayloadLimitIssue
);

export const sharedRecipeResponseSchema = z.object({
  recipe: sharedRecipeSchema
});

const updateSharedRecipeRequestBaseSchema = z.object({
  recipe: recipeSchema.optional(),
  notes: sharedRecipeNotesSchema.nullable().optional(),
  fetchMode: fetchModeSchema.optional(),
  provenance: z.array(extractionProvenanceSchema).optional(),
  strategy: extractionStrategySchema.optional(),
  warnings: sharedRecipeWarningsSchema.optional()
});

export const updateSharedRecipeRequestSchema = updateSharedRecipeRequestBaseSchema.superRefine(
  addSharedRecipePayloadLimitIssue
);

export const deleteSharedRecipeResponseSchema = z.object({
  status: z.literal("deleted")
});

export const MAX_HOUSEHOLD_SHOPPING_ITEMS = 300;

const shoppingItemIdSchema = z.string().trim().min(1).max(120);

export const householdShoppingListResponseSchema = z.object({
  items: z.array(shoppingItemSchema).max(MAX_HOUSEHOLD_SHOPPING_ITEMS)
});

export const upsertShoppingItemsRequestSchema = z.object({
  items: z.array(shoppingItemSchema).min(1).max(MAX_HOUSEHOLD_SHOPPING_ITEMS)
});

export const upsertShoppingItemsResponseSchema = z.object({
  items: z.array(shoppingItemSchema).max(MAX_HOUSEHOLD_SHOPPING_ITEMS),
  ignored: z
    .array(
      z.object({
        id: shoppingItemIdSchema,
        reason: z.literal("older_update"),
        existingUpdatedAt: z.string().datetime()
      })
    )
    .default([])
});

export const deleteShoppingItemInputSchema = z.object({
  id: shoppingItemIdSchema,
  updatedAt: z.string().datetime()
});

export const deleteShoppingItemsRequestSchema = z.object({
  items: z.array(deleteShoppingItemInputSchema).min(1).max(MAX_HOUSEHOLD_SHOPPING_ITEMS)
});

export const deleteShoppingItemsResponseSchema = z.object({
  status: z.literal("deleted"),
  deletedItemIds: z.array(shoppingItemIdSchema),
  ignored: z
    .array(
      z.object({
        id: shoppingItemIdSchema,
        reason: z.literal("older_update"),
        existingUpdatedAt: z.string().datetime()
      })
    )
    .default([])
});

export const analyticsPlatformSchema = z.enum([
  "marketing_site",
  "web_app",
  "android_app",
  "backend",
  "unknown"
]);

export const analyticsEventNameSchema = z.enum([
  "marketing_page_viewed",
  "marketing_cta_clicked",
  "marketing_support_viewed",
  "marketing_privacy_viewed",
  "marketing_play_store_clicked",
  "marketing_web_app_clicked",
  "marketing_invite_page_viewed",
  "marketing_ios_waitlist_submitted",
  "import_started",
  "import_succeeded",
  "import_failed",
  "import_needs_retry",
  "import_cancelled",
  "import_abandoned",
  "recipe_opened",
  "cook_mode_started",
  "cook_mode_completed",
  "recipe_saved",
  "family_shared",
  "upgrade_viewed",
  "upgrade_purchased",
  "shopping_item_added",
  "shopping_item_checked",
  "web_app_loaded",
  "web_route_viewed",
  "web_install_cta_viewed",
  "web_install_cta_clicked",
  "web_sign_in_started",
  "web_sign_in_completed",
  "web_sign_out_completed",
  "web_pricing_viewed",
  "web_checkout_started",
  "web_billing_manage_clicked",
  "web_extract_submitted",
  "web_recipe_saved",
  "web_household_viewed",
  "web_household_invite_created",
  "web_support_opened",
  "android_app_opened",
  "android_screen_viewed",
  "android_first_open",
  "android_sign_in_started",
  "android_sign_in_completed",
  "android_sign_out_completed",
  "android_pricing_viewed",
  "android_checkout_started",
  "android_purchase_restored",
  "android_extract_submitted",
  "android_recipe_saved",
  "android_image_import_started",
  "android_image_import_submitted",
  "android_household_viewed",
  "android_household_invite_created",
  "android_support_opened",
  "client_error",
  // Added with the app overhaul. Deploy the API before clients that send them: an older API
  // drops (and, before tolerant ingestion, rejected whole batches with) unknown names.
  "recipe_favorited",
  "recipe_rated",
  "recipe_tagged",
  "collection_created",
  "meal_plan_entry_added",
  "meal_plan_shopping_generated",
  "library_exported",
  "library_imported",
  "shopping_list_shared",
  "cook_timer_started",
  "command_palette_used",
  "theme_changed",
  "units_changed",
  "import_queued_offline",
  "web_vitals"
]);

const analyticsUuidSchema = z.string().uuid();
const analyticsIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9:_-]+$/iu);
const analyticsPropertyValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export const MAX_ANALYTICS_EVENT_PROPERTY_COUNT = 40;
export const MAX_ANALYTICS_EVENT_PROPERTIES_CHARS = 4_000;

const analyticsEventPropertiesRecordSchema = z.record(
  z.string().trim().min(1).max(80),
  analyticsPropertyValueSchema
);

const NON_STRING_ANALYTICS_VALUE_CHARS = 8;

const measureAnalyticsPropertiesChars = (properties: Record<string, unknown>): number => {
  let total = 0;

  for (const [key, value] of Object.entries(properties)) {
    total += key.length;
    total += typeof value === "string" ? value.length : NON_STRING_ANALYTICS_VALUE_CHARS;
  }

  return total;
};

export const analyticsEventPropertiesSchema = z
  .unknown()
  .superRefine((properties, context) => {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      return;
    }

    const record = properties as Record<string, unknown>;
    const keyCount = Object.keys(record).length;

    if (keyCount > MAX_ANALYTICS_EVENT_PROPERTY_COUNT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message: `Analytics events accept at most ${MAX_ANALYTICS_EVENT_PROPERTY_COUNT} properties.`
      });

      return;
    }

    if (measureAnalyticsPropertiesChars(record) > MAX_ANALYTICS_EVENT_PROPERTIES_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        fatal: true,
        message: "Analytics event properties are too large."
      });
    }
  })
  .pipe(analyticsEventPropertiesRecordSchema);

export const analyticsEventInputSchema = z.object({
  eventName: analyticsEventNameSchema,
  occurredAt: z.string().datetime().optional(),
  platform: analyticsPlatformSchema,
  anonymousId: analyticsUuidSchema.optional(),
  sessionId: analyticsUuidSchema.optional(),
  correlationId: analyticsUuidSchema.optional(),
  requestId: analyticsIdentifierSchema.optional(),
  routeOrScreen: z.string().trim().min(1).max(240).optional(),
  appVersion: z.string().trim().min(1).max(80).optional(),
  buildNumber: z.string().trim().min(1).max(80).optional(),
  referrerHostname: z.string().trim().min(1).max(240).optional(),
  utmSource: z.string().trim().min(1).max(120).optional(),
  utmMedium: z.string().trim().min(1).max(120).optional(),
  utmCampaign: z.string().trim().min(1).max(160).optional(),
  deviceClass: z.string().trim().min(1).max(60).optional(),
  osName: z.string().trim().min(1).max(60).optional(),
  browserName: z.string().trim().min(1).max(60).optional(),
  properties: analyticsEventPropertiesSchema.default({})
});

export const MAX_ANALYTICS_EVENTS_PER_BATCH = 25;

export const analyticsEventBatchRequestSchema = z.object({
  events: z.array(analyticsEventInputSchema).min(1).max(MAX_ANALYTICS_EVENTS_PER_BATCH)
});

/**
 * The batch envelope the API validates first. Events are then validated one by one, so a
 * single event with a name this API does not know yet (a newer client) or a bad property is
 * dropped and counted instead of failing the whole batch.
 */
export const analyticsEventBatchEnvelopeSchema = z.object({
  events: z.array(z.unknown()).min(1).max(MAX_ANALYTICS_EVENTS_PER_BATCH)
});

export const analyticsEventBatchResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  // Optional, additive: events that failed validation and were skipped.
  dropped: z.number().int().nonnegative().optional()
});

export interface ParsedAnalyticsEventBatch {
  events: AnalyticsEventInput[];
  dropped: number;
  /** Where each dropped event failed, e.g. "events.3.eventName" (no values, safe to log). */
  droppedPaths: string[];
}

/**
 * Validates an analytics batch leniently: null when the envelope itself is invalid (not an
 * object, no events, too many events), otherwise the valid events plus a count of dropped ones.
 */
export const parseAnalyticsEventBatch = (payload: unknown): ParsedAnalyticsEventBatch | null => {
  const envelope = analyticsEventBatchEnvelopeSchema.safeParse(payload);

  if (!envelope.success) {
    return null;
  }

  const events: AnalyticsEventInput[] = [];
  const droppedPaths: string[] = [];

  envelope.data.events.forEach((candidate, index) => {
    const parsed = analyticsEventInputSchema.safeParse(candidate);

    if (parsed.success) {
      events.push(parsed.data);
      return;
    }

    const firstIssuePath = parsed.error.issues[0]?.path.join(".") ?? "";
    droppedPaths.push(firstIssuePath ? `events.${index}.${firstIssuePath}` : `events.${index}`);
  });

  return { events, dropped: droppedPaths.length, droppedPaths };
};

export type AccountUser = z.infer<typeof accountUserSchema>;
export type UpdateAccountProfileRequest = z.infer<typeof updateAccountProfileRequestSchema>;
export type UpdateAccountProfileResponse = z.infer<typeof updateAccountProfileResponseSchema>;
export type RequestLoginCodeRequest = z.infer<typeof requestLoginCodeRequestSchema>;
export type RequestLoginCodeResponse = z.infer<typeof requestLoginCodeResponseSchema>;
export type VerifyLoginCodeRequest = z.infer<typeof verifyLoginCodeRequestSchema>;
export type VerifyLoginCodeResponse = z.infer<typeof verifyLoginCodeResponseSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type AuthMode = z.infer<typeof authModeSchema>;
export type AuthConfigResponse = z.infer<typeof authConfigResponseSchema>;
export type PaidBillingPlan = z.infer<typeof paidBillingPlanSchema>;
export type BillingPeriod = z.infer<typeof billingPeriodSchema>;
export type WebBillingAvailability = z.infer<typeof webBillingAvailabilitySchema>;
export type CreateWebBillingCheckoutRequest = z.infer<typeof createWebBillingCheckoutRequestSchema>;
export type WebBillingRedirectResponse = z.infer<typeof webBillingRedirectResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
export type DeleteAccountResponse = z.infer<typeof deleteAccountResponseSchema>;
export type HouseholdMember = z.infer<typeof householdMemberSchema>;
export type HouseholdInviteCode = z.infer<typeof householdInviteCodeSchema>;
export type HouseholdInviteSummary = z.infer<typeof householdInviteSummarySchema>;
export type HouseholdInviteShare = z.infer<typeof householdInviteShareSchema>;
export type HouseholdDetails = z.infer<typeof householdDetailsSchema>;
export type HouseholdSummary = z.infer<typeof householdSummarySchema>;
export type CreateHouseholdResponse = z.infer<typeof createHouseholdResponseSchema>;
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;
export type CancelInviteRequest = z.infer<typeof cancelInviteRequestSchema>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
export type RemoveHouseholdMemberRequest = z.infer<typeof removeHouseholdMemberRequestSchema>;
export type HouseholdMutationResponse = z.infer<typeof householdMutationResponseSchema>;
export type SharedRecipe = z.infer<typeof sharedRecipeSchema>;
export type SharedRecipeListResponse = z.infer<typeof sharedRecipeListResponseSchema>;
export type UpsertSharedRecipeRequest = z.infer<typeof upsertSharedRecipeRequestSchema>;
export type SharedRecipeResponse = z.infer<typeof sharedRecipeResponseSchema>;
export type UpdateSharedRecipeRequest = z.infer<typeof updateSharedRecipeRequestSchema>;
export type DeleteSharedRecipeResponse = z.infer<typeof deleteSharedRecipeResponseSchema>;
export type HouseholdShoppingListResponse = z.infer<typeof householdShoppingListResponseSchema>;
export type UpsertShoppingItemsRequest = z.infer<typeof upsertShoppingItemsRequestSchema>;
export type UpsertShoppingItemsResponse = z.infer<typeof upsertShoppingItemsResponseSchema>;
export type DeleteShoppingItemInput = z.infer<typeof deleteShoppingItemInputSchema>;
export type DeleteShoppingItemsRequest = z.infer<typeof deleteShoppingItemsRequestSchema>;
export type DeleteShoppingItemsResponse = z.infer<typeof deleteShoppingItemsResponseSchema>;
export type AnalyticsPlatform = z.infer<typeof analyticsPlatformSchema>;
export type AnalyticsEventName = z.infer<typeof analyticsEventNameSchema>;
export type AnalyticsEventProperties = z.infer<typeof analyticsEventPropertiesSchema>;
export type AnalyticsEventInput = z.infer<typeof analyticsEventInputSchema>;
export type AnalyticsEventBatchRequest = z.infer<typeof analyticsEventBatchRequestSchema>;
export type AnalyticsEventBatchResponse = z.infer<typeof analyticsEventBatchResponseSchema>;
