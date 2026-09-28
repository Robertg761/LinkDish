import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { claimCheckoutSuccess, getLastCheckoutPlan } from "../billing/checkout-session";

import { planContent } from "./plans-content";
import { SUPPORT_EMAIL } from "./PricingSections";

import type { WebBillingTier } from "../billing/web-billing";
import type { PaidBillingPlan } from "@linkdish/api-contracts";

import "./CheckoutStatus.css";

/** When to ask the API for the new plan after a checkout returns (ms after the previous ask). */
export const CHECKOUT_CONFIRM_DELAYS_MS: ReadonlyArray<number> = [0, 2_000, 3_000, 5_000, 8_000];

type ConfirmState = "checking" | "confirmed" | "delayed";

const isPlanActive = (plan: WebBillingTier, expected: PaidBillingPlan | null): boolean =>
  expected ? plan === expected || (expected === "plus" && plan === "family") : plan !== "free";

interface CheckoutSuccessProps {
  accountPlan: WebBillingTier;
  isAuthenticated: boolean;
  refreshUser: () => Promise<void>;
  onDismiss: () => void;
  /** Overridable in tests. */
  delays?: ReadonlyArray<number> | undefined;
}

/**
 * The return from a hosted checkout (`?checkout=success`): reports the purchase once per checkout,
 * asks the API for the new plan a few times until it shows up, then celebrates.
 */
export const CheckoutSuccess: React.FC<CheckoutSuccessProps> = ({
  accountPlan,
  isAuthenticated,
  refreshUser,
  onDismiss,
  delays = CHECKOUT_CONFIRM_DELAYS_MS
}) => {
  const [expectedPlan] = useState<PaidBillingPlan | null>(() => getLastCheckoutPlan());
  const confirmed = isAuthenticated && isPlanActive(accountPlan, expectedPlan);
  const [pollRound, setPollRound] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;

  useEffect(() => {
    const purchase = claimCheckoutSuccess();

    if (!purchase) {
      return;
    }

    trackWebV2AnalyticsEvent({
      name: "upgrade_purchased",
      routeOrScreen: window.location.pathname,
      properties: {
        ...(purchase.period ? { billing_period: purchase.period } : {}),
        plan: purchase.plan,
        trigger: purchase.trigger
      }
    });
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;

    const check = async () => {
      if (cancelled || confirmedRef.current) {
        return;
      }

      try {
        await refreshUser();
      } catch {
        // A failed refresh just means we try again on the next tick.
      }

      attempt += 1;

      if (cancelled || confirmedRef.current) {
        return;
      }

      const nextDelay = delays[attempt];

      if (nextDelay === undefined) {
        setExhausted(true);
        return;
      }

      timer = window.setTimeout(() => void check(), nextDelay);
    };

    setExhausted(false);
    timer = window.setTimeout(() => void check(), delays[0] ?? 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [delays, isAuthenticated, pollRound, refreshUser]);

  const state: ConfirmState = confirmed ? "confirmed" : exhausted ? "delayed" : "checking";
  const confirmedPlan: PaidBillingPlan | null =
    accountPlan === "plus" || accountPlan === "family" ? accountPlan : null;

  if (!isAuthenticated) {
    return (
      <CheckoutCard icon="party-popper" onDismiss={onDismiss} tone="celebrate">
        <h2 className="checkout-status-title">Thank you!</h2>
        <p className="checkout-status-body">
          Your payment went through. Sign in with the account you upgraded to start using your new
          plan.
        </p>
        <div className="checkout-status-actions">
          <ButtonLink icon="log-in" to="/account">
            Sign in
          </ButtonLink>
        </div>
      </CheckoutCard>
    );
  }

  if (state === "confirmed" && confirmedPlan) {
    return (
      <CheckoutCard icon="party-popper" onDismiss={onDismiss} tone="celebrate">
        <h2 className="checkout-status-title">Welcome to {planContent[confirmedPlan].name}!</h2>
        <p className="checkout-status-body">
          {confirmedPlan === "family"
            ? "Your Family plan is active. Start a household and invite the people you cook with."
            : "Your plan is active: 100 imports every month and room for every recipe you save."}
        </p>
        <div className="checkout-status-actions">
          {confirmedPlan === "family" ? (
            <ButtonLink icon="users" to="/household">
              Set up your household
            </ButtonLink>
          ) : (
            <ButtonLink icon="plus" to="/import">
              Add a recipe
            </ButtonLink>
          )}
          <ButtonLink to="/" variant="secondary">
            Go to your cookbook
          </ButtonLink>
        </div>
      </CheckoutCard>
    );
  }

  if (state === "delayed") {
    return (
      <CheckoutCard icon="check-circle" onDismiss={onDismiss} tone="neutral">
        <h2 className="checkout-status-title">Thanks, your payment went through</h2>
        <p className="checkout-status-body">
          Your new plan can take a minute to appear. Check again shortly, or email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if it still hasn&apos;t shown up.
        </p>
        <div className="checkout-status-actions">
          <Button
            icon="refresh"
            onClick={() => setPollRound((round) => round + 1)}
            variant="secondary"
          >
            Check again
          </Button>
        </div>
      </CheckoutCard>
    );
  }

  return (
    <CheckoutCard busy icon="loader" onDismiss={onDismiss} tone="neutral">
      <h2 className="checkout-status-title">Payment received</h2>
      <p className="checkout-status-body">Setting up your new plan. This only takes a moment.</p>
    </CheckoutCard>
  );
};

export const CheckoutCancelled: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => (
  <CheckoutCard icon="info" onDismiss={onDismiss} tone="neutral">
    <h2 className="checkout-status-title">Checkout cancelled</h2>
    <p className="checkout-status-body">
      Nothing was charged and your plan hasn&apos;t changed. Pick up where you left off whenever
      you&apos;re ready.
    </p>
  </CheckoutCard>
);

export const BillingErrorNotice: React.FC<{ message: string; onDismiss: () => void }> = ({
  message,
  onDismiss
}) => (
  <CheckoutCard icon="alert-circle" onDismiss={onDismiss} role="alert" tone="danger">
    <h2 className="checkout-status-title">That didn&apos;t go through</h2>
    <p className="checkout-status-body">
      {message} Need a hand? <Link to="/support">Contact support</Link>.
    </p>
  </CheckoutCard>
);

interface CheckoutCardProps {
  icon: React.ComponentProps<typeof Icon>["name"];
  tone: "celebrate" | "neutral" | "danger";
  onDismiss: () => void;
  busy?: boolean | undefined;
  role?: "alert" | "status" | undefined;
  children: React.ReactNode;
}

const CheckoutCard: React.FC<CheckoutCardProps> = ({
  icon,
  tone,
  onDismiss,
  busy = false,
  role = "status",
  children
}) => (
  <section
    aria-busy={busy || undefined}
    className={`checkout-status checkout-status-${tone}`}
    role={role}
  >
    <span className={`checkout-status-icon${busy ? " is-spinning" : ""}`} aria-hidden="true">
      <Icon name={icon} size={26} />
    </span>
    <div className="checkout-status-copy">{children}</div>
    <IconButton
      aria-label="Dismiss"
      className="checkout-status-dismiss"
      icon="x"
      onClick={onDismiss}
      size="sm"
    />
  </section>
);
