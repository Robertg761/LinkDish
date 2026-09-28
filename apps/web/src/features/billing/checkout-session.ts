import { safeGetItem, safeRemoveItem, safeSetItem } from "../../platform/safe-storage";

import type { BillingPeriod, PaidBillingPlan } from "@linkdish/api-contracts";

/**
 * Remembers the checkout this tab started, so the `?checkout=success` return can report
 * `upgrade_purchased` with the real plan exactly once per checkout — reloading the success page,
 * or coming back to it later in the session, never counts the purchase again.
 *
 * sessionStorage survives the round trip to the payment page because the redirect happens in the
 * same tab. When storage is blocked, an in-memory flag still stops repeats for this page load.
 */

export const CHECKOUT_SESSION_STORAGE_KEY = "linkdish:web:checkout:v1";

export type CheckoutBillingPeriod = BillingPeriod | "lifetime";

export type CheckoutTrigger =
  | "founding"
  | "household"
  | "import_limit"
  | "onboarding"
  | "pricing"
  | "unknown";

export interface PendingCheckout {
  plan: PaidBillingPlan;
  period: CheckoutBillingPeriod;
  trigger: CheckoutTrigger;
}

export interface CompletedCheckout {
  plan: PaidBillingPlan | "unknown";
  period?: CheckoutBillingPeriod | undefined;
  trigger: CheckoutTrigger;
}

interface StoredCheckout {
  status: "pending" | "reported";
  plan?: PaidBillingPlan | undefined;
  period?: CheckoutBillingPeriod | undefined;
  trigger?: CheckoutTrigger | undefined;
  startedAt?: string | undefined;
}

const PLANS: ReadonlyArray<PaidBillingPlan> = ["plus", "family"];
const PERIODS: ReadonlyArray<CheckoutBillingPeriod> = ["monthly", "yearly", "lifetime"];
const TRIGGERS: ReadonlyArray<CheckoutTrigger> = [
  "founding",
  "household",
  "import_limit",
  "onboarding",
  "pricing",
  "unknown"
];

let reportedInMemory = false;

const readStoredCheckout = (): StoredCheckout | null => {
  const raw = safeGetItem(CHECKOUT_SESSION_STORAGE_KEY, "session");

  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as Partial<StoredCheckout> | null;

    if (!value || (value.status !== "pending" && value.status !== "reported")) {
      return null;
    }

    return {
      status: value.status,
      plan: PLANS.includes(value.plan as PaidBillingPlan) ? value.plan : undefined,
      period: PERIODS.includes(value.period as CheckoutBillingPeriod) ? value.period : undefined,
      trigger: TRIGGERS.includes(value.trigger as CheckoutTrigger) ? value.trigger : undefined,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined
    };
  } catch {
    return null;
  }
};

const writeStoredCheckout = (value: StoredCheckout): void => {
  safeSetItem(CHECKOUT_SESSION_STORAGE_KEY, JSON.stringify(value), "session");
};

/** Call right before sending the person to the payment page. */
export const rememberPendingCheckout = (checkout: PendingCheckout): void => {
  reportedInMemory = false;
  writeStoredCheckout({ ...checkout, startedAt: new Date().toISOString(), status: "pending" });
};

/** Forget a checkout that never reached the payment page (e.g. the request failed). */
export const clearPendingCheckout = (): void => {
  const stored = readStoredCheckout();

  if (stored?.status === "pending") {
    safeRemoveItem(CHECKOUT_SESSION_STORAGE_KEY, "session");
  }
};

/** The plan the pending checkout is for, if this tab started one. */
export const getPendingCheckout = (): PendingCheckout | null => {
  const stored = readStoredCheckout();

  if (stored?.status !== "pending" || !stored.plan || !stored.period) {
    return null;
  }

  return { period: stored.period, plan: stored.plan, trigger: stored.trigger ?? "pricing" };
};

/** The plan of the most recent checkout this tab started, reported or not. */
export const getLastCheckoutPlan = (): PaidBillingPlan | null => readStoredCheckout()?.plan ?? null;

/**
 * Claims the purchase report for a `?checkout=success` return. Returns the details to report the
 * first time, and null for every later call until another checkout starts.
 */
export const claimCheckoutSuccess = (): CompletedCheckout | null => {
  const stored = readStoredCheckout();

  if (stored?.status === "reported" || reportedInMemory) {
    return null;
  }

  reportedInMemory = true;
  writeStoredCheckout({ ...(stored ?? {}), status: "reported" });

  if (stored?.status === "pending" && stored.plan) {
    return {
      period: stored.period,
      plan: stored.plan,
      trigger: stored.trigger ?? "pricing"
    };
  }

  return { plan: "unknown", trigger: "pricing" };
};

/** Test seam. */
export const resetCheckoutSessionForTests = (): void => {
  reportedInMemory = false;
  safeRemoveItem(CHECKOUT_SESSION_STORAGE_KEY, "session");
};
