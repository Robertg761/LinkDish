import { useCallback, useState } from "react";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { isExtractorApiError } from "../../api/errors";
import { useAuth } from "../../auth/AuthProvider";

import { clearPendingCheckout, rememberPendingCheckout } from "./checkout-session";
import {
  isCheckoutCancelledError,
  isRevenueCatWebSdkCheckoutConfigured,
  startRevenueCatWebSdkCheckout,
  startRevenueCatWebSdkFoundingCheckout
} from "./revenuecat-web-sdk-checkout";

import type { CheckoutTrigger } from "./checkout-session";
import type { BillingPeriod, PaidBillingPlan } from "@linkdish/api-contracts";

export const CHECKOUT_UNAVAILABLE_MESSAGE =
  "Online checkout isn't available right now. Email support@linkdish.ca and we'll get you set up.";

/** Billing errors in plain words; "not set up" answers from the API get a support fallback. */
export const getCheckoutErrorMessage = (failure: unknown): string =>
  isExtractorApiError(failure) && (failure.statusCode === 404 || failure.statusCode === 503)
    ? CHECKOUT_UNAVAILABLE_MESSAGE
    : getFriendlyErrorMessage(failure, "billing");

export type CheckoutAction = `${PaidBillingPlan}-${BillingPeriod}` | "founding" | "portal";

/**
 * - purchased: the in-page checkout finished and the account was refreshed.
 * - redirected: the browser is on its way to the payment or billing page.
 * - cancelled: the person closed the in-page checkout.
 * - failed: `error` holds a friendly message.
 */
export type CheckoutOutcome = "purchased" | "redirected" | "cancelled" | "failed";

export interface WebCheckout {
  busyAction: CheckoutAction | null;
  error: string | null;
  clearError: () => void;
  startCheckout: (plan: PaidBillingPlan, period: BillingPeriod) => Promise<CheckoutOutcome>;
  startFoundingCheckout: () => Promise<CheckoutOutcome>;
  openBillingPortal: () => Promise<CheckoutOutcome>;
}

/**
 * Checkout and billing-portal actions shared by the pricing page and the upgrade sheet. Uses the
 * in-page RevenueCat checkout when this build has a web key, and otherwise the API's hosted
 * checkout link. Errors come back as plain-language copy, never provider names.
 */
export function useWebCheckout({ trigger }: { trigger: CheckoutTrigger }): WebCheckout {
  const { refreshUser, user } = useAuth();
  const [busyAction, setBusyAction] = useState<CheckoutAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((failure: unknown): CheckoutOutcome => {
    setBusyAction(null);

    if (isCheckoutCancelledError(failure)) {
      return "cancelled";
    }

    setError(getCheckoutErrorMessage(failure));
    return "failed";
  }, []);

  const startCheckout = useCallback(
    async (plan: PaidBillingPlan, period: BillingPeriod): Promise<CheckoutOutcome> => {
      setBusyAction(`${plan}-${period}`);
      setError(null);

      try {
        if (isRevenueCatWebSdkCheckoutConfigured() && user) {
          await startRevenueCatWebSdkCheckout({ period, plan, user });
          trackWebV2AnalyticsEvent({
            name: "upgrade_purchased",
            routeOrScreen: window.location.pathname,
            properties: {
              billing_period: period,
              plan,
              trigger
            }
          });
          await refreshUser();
          setBusyAction(null);
          return "purchased";
        }

        rememberPendingCheckout({ period, plan, trigger });
        const response = await apiClient.createWebBillingCheckout({ period, plan });
        window.location.assign(response.url);
        return "redirected";
      } catch (failure) {
        clearPendingCheckout();
        return fail(failure);
      }
    },
    [fail, refreshUser, trigger, user]
  );

  const startFoundingCheckout = useCallback(async (): Promise<CheckoutOutcome> => {
    setBusyAction("founding");
    setError(null);

    try {
      if (isRevenueCatWebSdkCheckoutConfigured() && user) {
        await startRevenueCatWebSdkFoundingCheckout({ user });
        trackWebV2AnalyticsEvent({
          name: "upgrade_purchased",
          routeOrScreen: window.location.pathname,
          properties: {
            billing_period: "lifetime",
            plan: "plus",
            trigger: "founding"
          }
        });
        await refreshUser();
        setBusyAction(null);
        return "purchased";
      }

      rememberPendingCheckout({ period: "lifetime", plan: "plus", trigger: "founding" });
      const response = await apiClient.createWebBillingCheckout({ offer: "founding" });
      window.location.assign(response.url);
      return "redirected";
    } catch (failure) {
      clearPendingCheckout();
      return fail(failure);
    }
  }, [fail, refreshUser, user]);

  const openBillingPortal = useCallback(async (): Promise<CheckoutOutcome> => {
    setBusyAction("portal");
    setError(null);

    try {
      const response = await apiClient.createWebBillingPortal();
      window.location.assign(response.url);
      return "redirected";
    } catch (failure) {
      return fail(failure);
    }
  }, [fail]);

  const clearError = useCallback(() => setError(null), []);

  return {
    busyAction,
    clearError,
    error,
    openBillingPortal,
    startCheckout,
    startFoundingCheckout
  };
}
