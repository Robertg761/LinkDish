export type PaidBillingTier = "plus" | "family";
export type BillingTier = "free" | PaidBillingTier;

export interface PlanLimits {
  monthlyImports: number;
  monthlyStrongExtractions: number;
  savedRecipes: number | null;
}

export interface BillingPlan {
  id: BillingTier;
  displayName: string;
  limits: PlanLimits;
  monthlyPrice: string;
  yearlyPrice: string;
}

export const paidBillingTiers = ["plus", "family"] as const satisfies readonly PaidBillingTier[];

export const billingPlans = {
  free: {
    id: "free",
    displayName: "Free",
    monthlyPrice: "$0",
    yearlyPrice: "$0",
    limits: {
      monthlyImports: 3,
      monthlyStrongExtractions: 3,
      savedRecipes: 15
    }
  },
  plus: {
    id: "plus",
    displayName: "LinkDish Plus",
    monthlyPrice: "$2.99",
    yearlyPrice: "$24.99",
    limits: {
      monthlyImports: 100,
      monthlyStrongExtractions: 100,
      savedRecipes: null
    }
  },
  family: {
    id: "family",
    displayName: "LinkDish Family",
    monthlyPrice: "$4.99",
    yearlyPrice: "$44.99",
    limits: {
      monthlyImports: 250,
      monthlyStrongExtractions: 250,
      savedRecipes: null
    }
  }
} satisfies Record<BillingTier, BillingPlan>;

export const formatLimit = (limit: number | null, unit: string): string =>
  limit == null ? `Unlimited ${unit}` : `${limit} ${unit}`;
