import { z } from "zod";

import { getUserByEmail, normalizeEmail } from "../auth/auth-service.js";
import { getEffectiveAccountBillingPlanId } from "../billing/account-billing-plan.js";
import {
  getRevenueCatBillingPlanIdFromSubscriber,
  getRevenueCatSubscriber,
  getTestPremiumBillingPlanId,
  type RevenueCatBillingPlanId,
  type RevenueCatSubscriber
} from "../billing/revenuecat-entitlements.js";
import {
  getActiveHouseholdQuotaForUser,
  getHouseholdSummaryForUser
} from "../households/household-service.js";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

type BillingPlanId = NonNullable<AccountUser["billingPlan"]>;

const stringField = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : null;
};

const recordEntries = (value: unknown): Array<[string, Record<string, unknown>]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1])
  );
};

const summarizeEntitlements = (subscriber: RevenueCatSubscriber) =>
  recordEntries(subscriber.entitlements).map(([id, entitlement]) => ({
    expiresAt: stringField(entitlement, "expires_date"),
    id,
    productIdentifier: stringField(entitlement, "product_identifier"),
    purchaseAt: stringField(entitlement, "purchase_date")
  }));

const summarizeSubscriptions = (subscriber: RevenueCatSubscriber) =>
  recordEntries(subscriber.subscriptions).map(([productId, subscription]) => ({
    billingIssueDetectedAt: stringField(subscription, "billing_issues_detected_at"),
    expiresAt: stringField(subscription, "expires_date"),
    ownershipType: stringField(subscription, "ownership_type"),
    periodType: stringField(subscription, "period_type"),
    productId,
    purchaseAt: stringField(subscription, "purchase_date"),
    store: stringField(subscription, "store"),
    unsubscribeDetectedAt: stringField(subscription, "unsubscribe_detected_at")
  }));

const summarizeNonSubscriptions = (subscriber: RevenueCatSubscriber) =>
  Object.entries(subscriber.non_subscriptions ?? {}).flatMap(([productId, purchases]) =>
    purchases
      .filter(
        (purchase): purchase is Record<string, unknown> =>
          Boolean(purchase) && typeof purchase === "object" && !Array.isArray(purchase)
      )
      .map((purchase) => ({
        id: stringField(purchase, "id"),
        isSandbox: Boolean(purchase.is_sandbox),
        productId,
        purchaseAt: stringField(purchase, "purchase_date"),
        store: stringField(purchase, "store")
      }))
  );

const summarizeSubscriber = (subscriber: RevenueCatSubscriber) => ({
  entitlements: summarizeEntitlements(subscriber),
  firstSeenAt: stringField(subscriber as Record<string, unknown>, "first_seen"),
  lastSeenAt: stringField(subscriber as Record<string, unknown>, "last_seen"),
  managementUrl: stringField(subscriber as Record<string, unknown>, "management_url"),
  nonSubscriptions: summarizeNonSubscriptions(subscriber),
  originalAppUserId: stringField(subscriber as Record<string, unknown>, "original_app_user_id"),
  subscriptions: summarizeSubscriptions(subscriber)
});

export const adminUserLookupQuerySchema = z.object({
  email: z.string().trim().email().max(254)
});

export type AdminUserLookupQuery = z.infer<typeof adminUserLookupQuerySchema>;

export class AdminUserAccountError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "AdminUserAccountError";
  }
}

export const getAdminUserAccountDetails = async (
  query: AdminUserLookupQuery
): Promise<{
  billing: {
    effectivePlan: BillingPlanId | null;
    errors: string[];
    revenueCatConfigured: boolean;
    revenueCatPlan: RevenueCatBillingPlanId | null;
    subscriber: ReturnType<typeof summarizeSubscriber> | null;
    testPremiumPlan: Exclude<RevenueCatBillingPlanId, "free"> | null;
  };
  household: Awaited<ReturnType<typeof getHouseholdSummaryForUser>>["household"];
  householdQuota: Awaited<ReturnType<typeof getActiveHouseholdQuotaForUser>>;
  user: {
    avatarEmoji: string | null;
    createdAt: string;
    displayName: string | null;
    email: string;
    id: string;
    updatedAt: string;
  };
}> => {
  const normalizedEmail = normalizeEmail(query.email);
  const user = await getUserByEmail(normalizedEmail);

  if (!user) {
    throw new AdminUserAccountError("No active LinkDish account exists for that email.", 404);
  }

  const billingErrors: string[] = [];
  let subscriber: RevenueCatSubscriber | null = null;
  let revenueCatPlan: RevenueCatBillingPlanId | null = null;

  try {
    subscriber = await getRevenueCatSubscriber(user.id);
    revenueCatPlan = getRevenueCatBillingPlanIdFromSubscriber(subscriber);
  } catch (error) {
    billingErrors.push(error instanceof Error ? error.message : "RevenueCat lookup failed.");
  }

  let effectivePlan: BillingPlanId | null = null;

  try {
    effectivePlan = (await getEffectiveAccountBillingPlanId(user.id)) ?? null;
  } catch (error) {
    billingErrors.push(
      error instanceof Error ? error.message : "Effective billing plan lookup failed."
    );
  }

  const householdQuota = await getActiveHouseholdQuotaForUser(user.id).catch((error) => {
    billingErrors.push(error instanceof Error ? error.message : "Household quota lookup failed.");
    return null;
  });
  const { household } = await getHouseholdSummaryForUser(user.id).catch((error) => {
    billingErrors.push(error instanceof Error ? error.message : "Household lookup failed.");
    return { household: null };
  });

  return {
    billing: {
      effectivePlan,
      errors: billingErrors,
      revenueCatConfigured: billingErrors.length === 0 || subscriber != null,
      revenueCatPlan,
      subscriber: subscriber ? summarizeSubscriber(subscriber) : null,
      testPremiumPlan: getTestPremiumBillingPlanId(user.id)
    },
    household,
    householdQuota,
    user: {
      avatarEmoji: user.avatarEmoji ?? null,
      createdAt: user.createdAt,
      displayName: user.displayName ?? null,
      email: user.email,
      id: user.id,
      updatedAt: user.updatedAt
    }
  };
};
