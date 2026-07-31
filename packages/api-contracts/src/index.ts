import { z } from "zod";

import {
  missingRecipeFieldSchema,
  recipeSchema,
  shoppingItemSchema,
  sourceTypeSchema
} from "../../recipe-domain/src/index.js";

const imageMimeTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
const imageDataUrlSchema = z
  .string()
  .min(1)
  .max(4_500_000)
  .regex(/^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=\s]+$/iu);
const extractionCorrelationIdSchema = z.string().uuid();

export const extractRecipeImageSchema = z.object({
  dataUrl: imageDataUrlSchema,
  mimeType: imageMimeTypeSchema
});

const addImageExtractPayloadLimitIssue = (payload: unknown, context: z.RefinementCtx): void => {
  if (JSON.stringify(payload).length > 8_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Image extraction payload is too large."
    });
  }
};

const extractRecipeUrlRequestSchema = z.object({
  url: z.string().url(),
  attempt: z.enum(["primary", "fallback"]).default("primary"),
  correlationId: extractionCorrelationIdSchema.optional()
});

const extractRecipeImageRequestSchema = z
  .object({
    images: z.array(extractRecipeImageSchema).min(1).max(4),
    sourceUrl: z.string().url(),
    attempt: z.literal("fallback").default("fallback"),
    correlationId: extractionCorrelationIdSchema.optional()
  })
  .superRefine(addImageExtractPayloadLimitIssue);

export const extractRecipeRequestSchema = z.union([
  extractRecipeImageRequestSchema,
  extractRecipeUrlRequestSchema
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
  })
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
export type ExtractRecipeImage = z.infer<typeof extractRecipeImageSchema>;
export type ExtractRecipeResponse = z.infer<typeof extractRecipeResponseSchema>;
export type ExtractRecipeSuccess = z.infer<typeof extractRecipeSuccessSchema>;
export type ExtractRecipeNeedsRetry = z.infer<typeof extractRecipeNeedsRetrySchema>;
export type ExtractRecipeFailure = z.infer<typeof extractRecipeFailureSchema>;
export type QuotaMeteringMode = z.infer<typeof quotaMeteringModeSchema>;
export type QuotaStatus = z.infer<typeof quotaStatusSchema>;
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
  url: z.string().url()
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
  inviteUrl: z.string().url()
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
  "client_error"
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

export const analyticsEventPropertiesSchema = z.record(
  z.string().trim().min(1).max(80),
  analyticsPropertyValueSchema
);

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

export const analyticsEventBatchRequestSchema = z.object({
  events: z.array(analyticsEventInputSchema).min(1).max(25)
});

export const analyticsEventBatchResponseSchema = z.object({
  accepted: z.number().int().nonnegative()
});

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
