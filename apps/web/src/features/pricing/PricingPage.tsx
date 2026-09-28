import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { ProgressBar } from "../../components/ProgressBar";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useMediaQuery } from "../../lib/use-media-query";
import { useWebBillingAvailability } from "../billing/billing-availability";
import { useWebCheckout } from "../billing/use-web-checkout";
import {
  getRemainingImports,
  getWebBillingTier,
  webBillingPlans,
  type WebBillingTier
} from "../billing/web-billing";
import {
  getHouseholdOwner,
  getMemberDisplayName,
  useHouseholdSummary
} from "../household/use-household-summary";

import { BillingErrorNotice, CheckoutCancelled, CheckoutSuccess } from "./CheckoutStatus";
import { PlanCard, PlanStatus } from "./PlanCard";
import {
  getBestYearlySavings,
  getPurchasablePeriod,
  isBillingPeriod,
  isPaidPlan,
  planContent,
  RECOMMENDED_PLAN
} from "./plans-content";
import {
  BillingPeriodToggle,
  FoundingOfferCard,
  PlanComparisonTable,
  PricingFaq,
  PricingTrustRow,
  SUPPORT_EMAIL
} from "./PricingSections";

import type { BillingPeriod, PaidBillingPlan } from "@linkdish/api-contracts";

import "./PricingPage.css";

/** Side by side, Free sits first like a price ladder. */
const WIDE_TIERS: ReadonlyArray<WebBillingTier> = ["free", "plus", "family"];
/** Stacked on phones, the paid plans come first so they're visible without scrolling past Free. */
const STACKED_TIERS: ReadonlyArray<WebBillingTier> = ["plus", "family", "free"];
const WIDE_GRID_QUERY = "(min-width: 900px)";

/** Who pays for the plan the person is on, which decides whether "Manage billing" is theirs. */
type BillingOwner = "self" | "household" | "unknown";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export const PricingPage: React.FC = () => {
  useDocumentTitle("Plans");
  const { isAuthenticated, refreshUser, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPlanParam = searchParams.get("upgrade");
  const requestedPlan: PaidBillingPlan | null = isPaidPlan(requestedPlanParam)
    ? requestedPlanParam
    : null;
  const periodParam = searchParams.get("period");
  const [period, setPeriod] = useState<BillingPeriod>(
    isBillingPeriod(periodParam) ? periodParam : "yearly"
  );
  const checkoutResult = searchParams.get("checkout");
  const availabilityView = useWebBillingAvailability();
  const { availability } = availabilityView;
  const checkout = useWebCheckout({ trigger: "pricing" });
  const householdSummary = useHouseholdSummary(isAuthenticated, user?.id);
  const household = householdSummary.household;
  const accountPlan = getWebBillingTier(user);
  const currentPlan: WebBillingTier =
    isAuthenticated && household?.ownerFamilyEntitlementActive === true ? "family" : accountPlan;
  const billingOwner: BillingOwner =
    currentPlan !== "family"
      ? "self"
      : householdSummary.status === "ready"
        ? household?.role === "member"
          ? "household"
          : "self"
        : "unknown";
  const householdOwner = billingOwner === "household" ? getHouseholdOwner(household) : null;
  const canManageBilling =
    isAuthenticated &&
    currentPlan !== "free" &&
    billingOwner === "self" &&
    availability.managementPortalAvailable;
  const remainingImports = isAuthenticated ? null : getRemainingImports("free");
  const bestSavings = getBestYearlySavings(availability);
  const tiers = useMediaQuery(WIDE_GRID_QUERY) ? WIDE_TIERS : STACKED_TIERS;
  const cardRefs = useRef<Partial<Record<WebBillingTier, HTMLElement | null>>>({});

  useEffect(() => {
    trackWebV2AnalyticsEvent({
      name: "upgrade_viewed",
      routeOrScreen: window.location.pathname,
      properties: {
        trigger: "pricing"
      }
    });
  }, []);

  // Arriving with ?upgrade=plus|family (from the upgrade sheet, or back from sign-in): bring that
  // plan into view.
  useEffect(() => {
    if (!requestedPlan) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      cardRefs.current[requestedPlan]?.scrollIntoView?.({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "center"
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [requestedPlan]);

  const dismissCheckoutResult = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("checkout");
    setSearchParams(next, { replace: true });
  };

  const signInPath = (plan: PaidBillingPlan) =>
    `/account?upgrade=${plan}${period === "monthly" ? "&period=monthly" : ""}`;

  const renderPaidAction = (plan: PaidBillingPlan): React.ReactNode => {
    const emphasize = plan === (requestedPlan ?? RECOMMENDED_PLAN);
    const planName = planContent[plan].name;

    if (currentPlan === plan) {
      if (billingOwner === "household") {
        const ownerName = householdOwner ? getMemberDisplayName(householdOwner) : null;

        return (
          <>
            <PlanStatus icon="users">
              {ownerName ? `Shared with you by ${ownerName}` : "Included with your household"}
            </PlanStatus>
            <p className="plan-card-action-note">
              Family comes from your household&apos;s plan, so there&apos;s nothing to pay or manage
              here. <Link to="/household">Open household</Link>
            </p>
          </>
        );
      }

      if (canManageBilling) {
        return (
          <Button
            fullWidth
            icon="credit-card"
            loading={checkout.busyAction === "portal"}
            onClick={() => void checkout.openBillingPortal()}
            variant="secondary"
          >
            Manage billing
          </Button>
        );
      }

      return (
        <>
          <PlanStatus icon="check-circle">Your current plan</PlanStatus>
          {billingOwner === "unknown" ? (
            <p className="plan-card-action-note">
              Billing is managed by the account that started this plan.
            </p>
          ) : null}
        </>
      );
    }

    if (currentPlan === "family" && plan === "plus") {
      return <PlanStatus tone="muted">Included in Family</PlanStatus>;
    }

    if (!isAuthenticated) {
      return (
        <ButtonLink
          fullWidth
          to={signInPath(plan)}
          trailingIcon="arrow-right"
          variant={emphasize ? "primary" : "secondary"}
        >
          Sign in to upgrade
        </ButtonLink>
      );
    }

    const purchasablePeriod = getPurchasablePeriod(plan, period, availabilityView);

    if (availabilityView.status === "error" && purchasablePeriod === null) {
      return (
        <>
          <Button fullWidth icon="refresh" onClick={availabilityView.retry} variant="secondary">
            Try again
          </Button>
          <p className="plan-card-action-note">We couldn&apos;t load checkout just now.</p>
        </>
      );
    }

    if (availabilityView.status === "loading" && purchasablePeriod === null) {
      return (
        <Button fullWidth loading variant={emphasize ? "primary" : "secondary"}>
          Upgrade to {planName}
        </Button>
      );
    }

    if (purchasablePeriod === null) {
      return (
        <p className="plan-card-action-note plan-card-action-note-box">
          Online checkout is taking a short break. Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`LinkDish ${planName}`)}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          and we&apos;ll get you set up.
        </p>
      );
    }

    return (
      <>
        <Button
          disabled={checkout.busyAction !== null}
          fullWidth
          loading={checkout.busyAction === `${plan}-${purchasablePeriod}`}
          onClick={() => void checkout.startCheckout(plan, purchasablePeriod)}
          variant={emphasize ? "primary" : "secondary"}
        >
          Upgrade to {planName}
        </Button>
        {purchasablePeriod !== period ? (
          <p className="plan-card-action-note">
            Only {purchasablePeriod} billing is available online right now.
          </p>
        ) : null}
      </>
    );
  };

  const renderFreeAction = (): React.ReactNode => {
    if (currentPlan !== "free") {
      return <PlanStatus tone="muted">Always free</PlanStatus>;
    }

    return <PlanStatus icon="check-circle">Your current plan</PlanStatus>;
  };

  const showFoundingOffer = availability.founding?.available === true && currentPlan === "free";

  return (
    <div className="pricing-page container-wide page-enter">
      {checkoutResult === "success" ? (
        <CheckoutSuccess
          accountPlan={accountPlan}
          isAuthenticated={isAuthenticated}
          onDismiss={dismissCheckoutResult}
          refreshUser={refreshUser}
        />
      ) : null}
      {checkoutResult === "cancelled" ? (
        <CheckoutCancelled onDismiss={dismissCheckoutResult} />
      ) : null}

      <PageHeader
        accent="juggle less."
        align="center"
        className="pricing-header"
        eyebrow="Plans"
        size="lg"
        subtitle="Save recipes from anywhere and cook from them calmly. Start free, and upgrade when your cookbook outgrows it."
        title="Cook more,"
      />

      {checkout.error ? (
        <BillingErrorNotice message={checkout.error} onDismiss={checkout.clearError} />
      ) : null}

      <div className="pricing-period">
        <BillingPeriodToggle bestSavings={bestSavings} onChange={setPeriod} value={period} />
      </div>

      <div className="pricing-grid">
        {tiers.map((tier) => (
          <PlanCard
            action={tier === "free" ? renderFreeAction() : renderPaidAction(tier)}
            availability={availability}
            isCurrent={currentPlan === tier}
            isRecommended={tier === RECOMMENDED_PLAN}
            isSelected={tier === requestedPlan && currentPlan !== tier}
            key={tier}
            period={period}
            ref={(element) => {
              cardRefs.current[tier] = element;
            }}
            tier={tier}
          >
            {tier === "free" && remainingImports !== null ? (
              <div className="pricing-usage">
                <div className="pricing-usage-row">
                  <span>Free imports left on this device</span>
                  <strong className="num">
                    {remainingImports} of {webBillingPlans.free.limits.monthlyImports}
                  </strong>
                </div>
                <ProgressBar
                  label="Free imports left"
                  max={webBillingPlans.free.limits.monthlyImports}
                  tone={remainingImports === 0 ? "tomato" : "primary"}
                  value={remainingImports}
                  valueText={`${remainingImports} of ${webBillingPlans.free.limits.monthlyImports} left`}
                />
              </div>
            ) : null}
          </PlanCard>
        ))}
      </div>

      {showFoundingOffer && availability.founding ? (
        <FoundingOfferCard
          action={
            isAuthenticated ? (
              <Button
                disabled={checkout.busyAction !== null}
                fullWidth
                loading={checkout.busyAction === "founding"}
                onClick={() => void checkout.startFoundingCheckout()}
              >
                Become a founding member
              </Button>
            ) : (
              <ButtonLink fullWidth to="/account?upgrade=plus">
                Sign in to claim
              </ButtonLink>
            )
          }
          priceLabel={availability.founding.priceLabel}
        />
      ) : null}

      <PricingTrustRow />

      {currentPlan === "family" ? (
        <section className="pricing-household-callout">
          <div>
            <h2>Your household</h2>
            <p>Invite the people you cook with and share one cookbook and shopping list.</p>
          </div>
          <ButtonLink icon="users" to="/household" variant="secondary">
            Manage household
          </ButtonLink>
        </section>
      ) : null}

      <PlanComparisonTable currentPlan={currentPlan} />
      <PricingFaq />
    </div>
  );
};
