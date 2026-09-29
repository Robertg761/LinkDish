import { useCallback, useState } from "react";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { isExtractorApiError } from "../../api/errors";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
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
 * - cancelled: the person closed the in-page checkout, or another account signed in before the
 *   checkout or billing page opened (it then never opens).
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

interface CheckoutState {
  /** The account the busy action and error belong to. */
  account: string | null;
  busyAction: CheckoutAction | null;
  error: string | null;
}

/**
 * Checkout and billing-portal actions shared by the pricing page and the upgrade sheet. Uses the
 * in-page RevenueCat checkout when this build has a web key, and otherwise the API's hosted
 * checkout link. Errors come back as plain-language copy, never provider names.
 *
 * Each action belongs to the account that started it: if another account signs in (or out)
 * before its checkout or billing page opens, the page never opens for the new one, and its busy
 * state and errors are never shown to it.
 *
 * A caller that unmounts when the account changes (the upgrade sheet closes then) passes
 * `isCurrentAccount` from a component that stays mounted: this hook's own check stops seeing new
 * accounts once its component is gone, and would let a late answer through.
 */
export function useWebCheckout({
  isCurrentAccount: liveIsCurrentAccount,
  trigger
}: {
  isCurrentAccount?: ((startedFor: string | null) => boolean) | undefined;
  trigger: CheckoutTrigger;
}): WebCheckout {
  const { isAuthenticated, refreshUser, user } = useAuth();
  const account = getAccountScope(isAuthenticated, user);
  const ownIsCurrentAccount = useIsCurrentAccount(account);
  const isCurrentAccount = liveIsCurrentAccount ?? ownIsCurrentAccount;
  const [state, setState] = useState<CheckoutState>({ account, busyAction: null, error: null });

  const begin = useCallback((startedFor: string | null, busyAction: CheckoutAction) => {
    setState({ account: startedFor, busyAction, error: null });
  }, []);

  /** The action that `startedFor` began is over. */
  const settle = useCallback((startedFor: string | null) => {
    setState((current) =>
      current.account === startedFor ? { ...current, busyAction: null } : current
    );
  }, []);

  const fail = useCallback(
    (startedFor: string | null, failure: unknown): CheckoutOutcome => {
      settle(startedFor);

      // Another account signed in meanwhile: whatever went wrong was the last one's.
      if (!isCurrentAccount(startedFor) || isCheckoutCancelledError(failure)) {
        return "cancelled";
      }

      setState({ account: startedFor, busyAction: null, error: getCheckoutErrorMessage(failure) });
      return "failed";
    },
    [isCurrentAccount, settle]
  );

  /** Opens a checkout or billing page, unless another account signed in while it was asked for. */
  const redirect = useCallback(
    (startedFor: string | null, url: string): CheckoutOutcome => {
      if (!isCurrentAccount(startedFor)) {
        clearPendingCheckout();
        settle(startedFor);
        return "cancelled";
      }

      window.location.assign(url);
      return "redirected";
    },
    [isCurrentAccount, settle]
  );

  const startCheckout = useCallback(
    async (plan: PaidBillingPlan, period: BillingPeriod): Promise<CheckoutOutcome> => {
      const startedFor = account;
      begin(startedFor, `${plan}-${period}`);

      try {
        if (isRevenueCatWebSdkCheckoutConfigured() && user) {
          await startRevenueCatWebSdkCheckout({
            isCurrent: () => isCurrentAccount(startedFor),
            period,
            plan,
            user
          });
          trackWebV2AnalyticsEvent({
            name: "upgrade_purchased",
            routeOrScreen: window.location.pathname,
            properties: {
              billing_period: period,
              plan,
              trigger
            }
          });

          // The purchase is the starting account's; refresh only while it is still signed in.
          if (isCurrentAccount(startedFor)) {
            await refreshUser();
          }

          settle(startedFor);
          return "purchased";
        }

        rememberPendingCheckout({ period, plan, trigger });
        const response = await apiClient.createWebBillingCheckout({ period, plan });
        return redirect(startedFor, response.url);
      } catch (failure) {
        clearPendingCheckout();
        return fail(startedFor, failure);
      }
    },
    [account, begin, fail, isCurrentAccount, redirect, refreshUser, settle, trigger, user]
  );

  const startFoundingCheckout = useCallback(async (): Promise<CheckoutOutcome> => {
    const startedFor = account;
    begin(startedFor, "founding");

    try {
      if (isRevenueCatWebSdkCheckoutConfigured() && user) {
        await startRevenueCatWebSdkFoundingCheckout({
          isCurrent: () => isCurrentAccount(startedFor),
          user
        });
        trackWebV2AnalyticsEvent({
          name: "upgrade_purchased",
          routeOrScreen: window.location.pathname,
          properties: {
            billing_period: "lifetime",
            plan: "plus",
            trigger: "founding"
          }
        });

        if (isCurrentAccount(startedFor)) {
          await refreshUser();
        }

        settle(startedFor);
        return "purchased";
      }

      rememberPendingCheckout({ period: "lifetime", plan: "plus", trigger: "founding" });
      const response = await apiClient.createWebBillingCheckout({ offer: "founding" });
      return redirect(startedFor, response.url);
    } catch (failure) {
      clearPendingCheckout();
      return fail(startedFor, failure);
    }
  }, [account, begin, fail, isCurrentAccount, redirect, refreshUser, settle, user]);

  const openBillingPortal = useCallback(async (): Promise<CheckoutOutcome> => {
    const startedFor = account;
    begin(startedFor, "portal");

    try {
      const response = await apiClient.createWebBillingPortal();
      // Never open one account's billing (its payment details and invoices) for another.
      return redirect(startedFor, response.url);
    } catch (failure) {
      return fail(startedFor, failure);
    }
  }, [account, begin, fail, redirect]);

  const clearError = useCallback(() => {
    setState((current) => (current.error === null ? current : { ...current, error: null }));
  }, []);

  // Only this account's busy action and error, never the last account's, even for a render.
  const shown = state.account === account ? state : null;

  return {
    busyAction: shown?.busyAction ?? null,
    clearError,
    error: shown?.error ?? null,
    openBillingPortal,
    startCheckout,
    startFoundingCheckout
  };
}
