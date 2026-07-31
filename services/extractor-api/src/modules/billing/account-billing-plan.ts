import { getActiveHouseholdQuotaForUser } from "../households/household-service.js";

import { getRevenueCatBillingPlanId } from "./revenuecat-entitlements.js";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

export const getEffectiveAccountBillingPlanId = async (
  userId: string
): Promise<AccountUser["billingPlan"]> => {
  let revenueCatPlan: AccountUser["billingPlan"];

  try {
    revenueCatPlan = await getRevenueCatBillingPlanId(userId);
  } catch (error) {
    console.warn("Failed to resolve RevenueCat billing plan for account.", error);
  }

  if (revenueCatPlan === "family") {
    return "family";
  }

  try {
    const activeHouseholdQuota = await getActiveHouseholdQuotaForUser(userId);

    if (activeHouseholdQuota) {
      return "family";
    }
  } catch (error) {
    console.warn("Failed to resolve household billing access for account.", error);
  }

  return revenueCatPlan;
};
