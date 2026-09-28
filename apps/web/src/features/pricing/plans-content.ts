import {
  DEFAULT_WEB_BILLING_AVAILABILITY,
  type WebBillingAvailabilityView
} from "../billing/billing-availability";
import {
  getMonthlyEquivalentLabel,
  getPriceAmountLabel,
  getYearlySavingsPercent
} from "../billing/price-format";
import { isRevenueCatWebSdkCheckoutConfigured } from "../billing/revenuecat-web-sdk-checkout";

import type { WebBillingTier } from "../billing/web-billing";
import type {
  BillingPeriod,
  PaidBillingPlan,
  WebBillingAvailability
} from "@linkdish/api-contracts";

/**
 * Plan copy shared by the pricing page, the upgrade sheet and the account page. Every claim here
 * must be true of the product today: limits match billing/web-billing.ts and the API, and features
 * that every plan has (cook mode, offline, no ads) are never sold as paid-only.
 */

export const defaultBillingAvailability: WebBillingAvailability = DEFAULT_WEB_BILLING_AVAILABILITY;

export interface PlanFeature {
  /** Bold lead-in, e.g. "100". */
  emphasis?: string;
  text: string;
}

export interface PlanCopy {
  name: string;
  /** One line under the plan name (matches the marketing site). */
  tagline: string;
  /** The three or four things that make this plan worth it. */
  highlights: PlanFeature[];
}

export const planContent: Record<WebBillingTier, PlanCopy> = {
  free: {
    highlights: [
      { emphasis: "3", text: " recipe imports to try it" },
      { emphasis: "Up to 15", text: " saved recipes" },
      { text: "Cook mode, shopping list and offline access" }
    ],
    name: "Free",
    tagline: "Try the whole idea."
  },
  plus: {
    highlights: [
      { emphasis: "100", text: " recipe imports every month" },
      { emphasis: "Unlimited", text: " saved recipes" },
      { text: "Everything in Free" }
    ],
    name: "Plus",
    tagline: "For your personal cookbook."
  },
  family: {
    highlights: [
      { emphasis: "250", text: " imports a month for the household" },
      { emphasis: "Up to 6 people", text: " share one cookbook" },
      { text: "One shopping list that syncs for everyone" },
      { text: "Everything in Plus" }
    ],
    name: "Family",
    tagline: "For the whole table."
  }
};

export const PAID_PLANS: ReadonlyArray<PaidBillingPlan> = ["plus", "family"];
export const RECOMMENDED_PLAN: PaidBillingPlan = "plus";

export const isPaidPlan = (value: unknown): value is PaidBillingPlan =>
  value === "plus" || value === "family";

export const isBillingPeriod = (value: unknown): value is BillingPeriod =>
  value === "monthly" || value === "yearly";

export interface PlanPriceDisplay {
  /** Big number, e.g. "$24.99". */
  amount: string;
  /** Unit after the big number, e.g. "/year". */
  unit: string;
  /** Supporting line, e.g. "$2.08 a month, billed yearly". */
  note: string;
  /** Whole-percent saving of yearly over monthly, when it can be worked out. */
  savingsPercent: number | null;
}

export const getPlanPriceDisplay = (
  tier: WebBillingTier,
  period: BillingPeriod,
  availability: WebBillingAvailability
): PlanPriceDisplay => {
  if (tier === "free") {
    return { amount: "$0", note: "Free for as long as you like", savingsPercent: null, unit: "" };
  }

  const prices = availability.prices[tier];

  if (period === "monthly") {
    return {
      amount: getPriceAmountLabel(prices.monthly),
      note: "Billed monthly · cancel anytime",
      savingsPercent: null,
      unit: "/month"
    };
  }

  const perMonth = getMonthlyEquivalentLabel(prices.yearly);

  return {
    amount: getPriceAmountLabel(prices.yearly),
    note: perMonth ? `${perMonth} a month, billed yearly` : "Billed yearly",
    savingsPercent: getYearlySavingsPercent(prices.monthly, prices.yearly),
    unit: "/year"
  };
};

/** The biggest yearly saving across paid plans, for the "Save up to N%" hint. */
export const getBestYearlySavings = (availability: WebBillingAvailability): number | null => {
  const savings = PAID_PLANS.map((plan) =>
    getYearlySavingsPercent(availability.prices[plan].monthly, availability.prices[plan].yearly)
  ).filter((value): value is number => value !== null);

  return savings.length > 0 ? Math.max(...savings) : null;
};

/**
 * Which billing period a plan can actually be bought with right now: the one asked for when it is
 * available, otherwise the other one, otherwise null (web checkout is off).
 */
export const getPurchasablePeriod = (
  plan: PaidBillingPlan,
  preferred: BillingPeriod,
  view: Pick<WebBillingAvailabilityView, "availability" | "status">
): BillingPeriod | null => {
  if (isRevenueCatWebSdkCheckoutConfigured()) {
    return preferred;
  }

  if (view.status !== "ready") {
    return null;
  }

  const plans = view.availability.plans[plan];
  const other: BillingPeriod = preferred === "yearly" ? "monthly" : "yearly";

  return plans[preferred] ? preferred : plans[other] ? other : null;
};

export interface PlanComparisonRow {
  label: string;
  hint?: string;
  values: Record<WebBillingTier, string | boolean>;
}

/** Only what's true in the product today. `true` renders a check, `false` a dash. */
export const planComparisonRows: ReadonlyArray<PlanComparisonRow> = [
  {
    label: "Recipe imports",
    hint: "From recipe sites, videos and photos",
    values: { family: "250/mo", free: "3 total", plus: "100/mo" }
  },
  {
    label: "Saved recipes",
    values: { family: "Unlimited", free: "15", plus: "Unlimited" }
  },
  {
    label: "Cook mode with timers",
    values: { family: true, free: true, plus: true }
  },
  {
    label: "Shopping list",
    values: { family: true, free: true, plus: true }
  },
  {
    label: "Works offline",
    hint: "Saved recipes open without a connection",
    values: { family: true, free: true, plus: true }
  },
  {
    label: "Family sharing",
    hint: "One shared cookbook for up to 6 people",
    values: { family: true, free: false, plus: false }
  },
  {
    label: "Household shopping list",
    hint: "Everyone adds and checks off the same list",
    values: { family: true, free: false, plus: false }
  },
  {
    label: "No ads",
    values: { family: true, free: true, plus: true }
  }
];
