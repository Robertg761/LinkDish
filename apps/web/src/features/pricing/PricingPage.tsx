import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import {
  isRevenueCatWebSdkCheckoutConfigured,
  startRevenueCatWebSdkCheckout,
  startRevenueCatWebSdkFoundingCheckout
} from "../billing/revenuecat-web-sdk-checkout";
import {
  getRemainingImports,
  getWebBillingTier,
  type WebBillingTier
} from "../billing/web-billing";

import {
  defaultBillingAvailability,
  FoundingOfferCard,
  getCheckoutButtonLabel,
  PricingPlansContent,
  type PlanActionsRenderer,
  UsageSummaryCard
} from "./plans-content";
import "./PricingPage.css";

import type {
  BillingPeriod,
  PaidBillingPlan,
  QuotaStatus,
  WebBillingAvailability
} from "@linkdish/api-contracts";

export const PricingPage: React.FC = () => {
  const { isAuthenticated, refreshUser, user } = useAuth();
  const [searchParams] = useSearchParams();
  const accountPlan = getWebBillingTier(user);
  const [householdPlan, setHouseholdPlan] = useState<WebBillingTier | null>(null);
  const [billingAvailability, setBillingAvailability] = useState<WebBillingAvailability>(
    defaultBillingAvailability
  );
  const [billingAction, setBillingAction] = useState<string | null>(null);
  const [billingError, setBillingError] = useState("");
  const currentPlan = householdPlan ?? accountPlan;
  const remainingImports = isAuthenticated ? null : getRemainingImports(currentPlan);
  const monthlyQuota = (user as (typeof user & { quota?: QuotaStatus }) | null)?.quota;
  const checkoutResult = searchParams.get("checkout");
  const refreshedCheckoutRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!isAuthenticated) {
      setHouseholdPlan(null);
      return;
    }

    setHouseholdPlan(null);

    async function loadHouseholdPlan() {
      try {
        const response = await apiClient.getHousehold();
        const hasActiveFamilyHousehold = response.household?.ownerFamilyEntitlementActive === true;

        if (!cancelled) {
          setHouseholdPlan(hasActiveFamilyHousehold ? "family" : null);
        }
      } catch {
        if (!cancelled) {
          setHouseholdPlan(null);
        }
      }
    }

    void loadHouseholdPlan();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    let cancelled = false;

    async function loadBillingAvailability() {
      try {
        const availability = await apiClient.getWebBillingAvailability();

        if (!cancelled) {
          setBillingAvailability(availability);
        }
      } catch {
        if (!cancelled) {
          setBillingAvailability(defaultBillingAvailability);
        }
      }
    }

    void loadBillingAvailability();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    trackWebV2AnalyticsEvent({
      name: "upgrade_viewed",
      routeOrScreen: window.location.pathname,
      properties: {
        trigger: "pricing"
      }
    });
  }, []);

  useEffect(() => {
    if (checkoutResult !== "success" || refreshedCheckoutRef.current === checkoutResult) {
      return;
    }

    refreshedCheckoutRef.current = checkoutResult;
    trackWebV2AnalyticsEvent({
      name: "upgrade_purchased",
      routeOrScreen: window.location.pathname,
      properties: {
        plan: "unknown",
        trigger: "pricing"
      }
    });
    void refreshUser();
  }, [checkoutResult, refreshUser]);

  const startCheckout = async (checkoutPlan: PaidBillingPlan, period: BillingPeriod) => {
    const actionId = `${checkoutPlan}-${period}`;
    setBillingAction(actionId);
    setBillingError("");

    try {
      if (isRevenueCatWebSdkCheckoutConfigured() && user) {
        await startRevenueCatWebSdkCheckout({
          period,
          plan: checkoutPlan,
          user
        });
        trackWebV2AnalyticsEvent({
          name: "upgrade_purchased",
          routeOrScreen: window.location.pathname,
          properties: {
            billing_period: period,
            plan: checkoutPlan,
            trigger: "pricing"
          }
        });
        await refreshUser();
        setBillingAction(null);
        return;
      }

      const response = await apiClient.createWebBillingCheckout({
        period,
        plan: checkoutPlan
      });
      window.location.assign(response.url);
    } catch (error) {
      setBillingError(
        error instanceof Error
          ? error.message
          : "LinkDish could not start checkout. Please try again."
      );
      setBillingAction(null);
    }
  };

  const startFoundingCheckout = async () => {
    setBillingAction("founding");
    setBillingError("");

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
        setBillingAction(null);
        return;
      }

      const response = await apiClient.createWebBillingCheckout({ offer: "founding" });
      window.location.assign(response.url);
    } catch (error) {
      setBillingError(
        error instanceof Error
          ? error.message
          : "LinkDish could not start checkout. Please try again."
      );
      setBillingAction(null);
    }
  };

  const openBillingPortal = async () => {
    setBillingAction("portal");
    setBillingError("");

    try {
      const response = await apiClient.createWebBillingPortal();
      window.location.assign(response.url);
    } catch (error) {
      setBillingError(
        error instanceof Error
          ? error.message
          : "LinkDish could not open billing management. Please try again."
      );
      setBillingAction(null);
    }
  };

  const renderPlanActions: PlanActionsRenderer = (checkoutPlan, prices) => {
    if (currentPlan === checkoutPlan) {
      const canManageBilling =
        accountPlan === checkoutPlan && billingAvailability.managementPortalAvailable;

      return canManageBilling ? (
        <Button
          variant="outline"
          loading={billingAction === "portal"}
          onClick={() => {
            void openBillingPortal();
          }}
          fullWidth
        >
          Manage Billing
        </Button>
      ) : (
        <Button variant="outline" disabled fullWidth>
          Active Plan
        </Button>
      );
    }

    if (!isAuthenticated) {
      return (
        <Link
          className="pricing-sign-in-link btn btn-primary btn-block"
          to={`/account?upgrade=${checkoutPlan}`}
        >
          Sign in to upgrade
        </Link>
      );
    }

    // The RevenueCat Web SDK path resolves offerings/packages client-side, so it does
    // not depend on backend Web Purchase Link availability. When it is configured, offer
    // both periods; otherwise fall back to the backend-driven Purchase Link availability.
    const webSdkCheckoutConfigured = isRevenueCatWebSdkCheckoutConfigured();
    const availablePeriods = (["yearly", "monthly"] as const).filter(
      (period) => webSdkCheckoutConfigured || billingAvailability.plans[checkoutPlan][period]
    );

    if (availablePeriods.length === 0) {
      return (
        <div className="pricing-upgrade-info">
          <Button variant="primary" disabled fullWidth>
            Web Checkout Setup Needed
          </Button>
          <p className="upgrade-note">
            Web purchases are almost ready. Finish RevenueCat Web Billing setup to enable checkout.
          </p>
        </div>
      );
    }

    return (
      <div className="pricing-upgrade-info">
        {availablePeriods.map((period) => (
          <Button
            key={period}
            variant={period === "yearly" ? "primary" : "secondary"}
            loading={billingAction === `${checkoutPlan}-${period}`}
            disabled={billingAction !== null}
            onClick={() => {
              void startCheckout(checkoutPlan, period);
            }}
            fullWidth
          >
            {getCheckoutButtonLabel(period, prices[period])}
          </Button>
        ))}
      </div>
    );
  };

  return (
    <div className="pricing-page container page-enter">
      <header className="pricing-header">
        <p className="pricing-eyebrow">Plans</p>
        <h1 className="pricing-title">LinkDish Plans & Pricing</h1>
        <p className="pricing-subtitle">
          Choose the perfect plan to clean and organize your culinary world.
        </p>
      </header>

      {checkoutResult === "success" && (
        <Card variant="subtle" className="billing-status-card">
          <h2>Checkout Complete</h2>
          <p>Thanks for upgrading. Your LinkDish plan will refresh once RevenueCat confirms it.</p>
        </Card>
      )}

      {checkoutResult === "cancelled" && (
        <Card variant="subtle" className="billing-status-card">
          <h2>Checkout Cancelled</h2>
          <p>No changes were made to your LinkDish plan.</p>
        </Card>
      )}

      {billingError && (
        <Card variant="subtle" className="billing-status-card">
          <h2>Billing Error</h2>
          <p>{billingError}</p>
        </Card>
      )}

      <UsageSummaryCard
        currentPlan={currentPlan}
        isAuthenticated={isAuthenticated}
        monthlyQuota={monthlyQuota}
        remainingImports={remainingImports}
      />

      <PricingPlansContent
        billingAvailability={billingAvailability}
        currentPlan={currentPlan}
        renderPlanActions={renderPlanActions}
      />

      {billingAvailability.founding?.available && currentPlan === "free" && (
        <FoundingOfferCard
          priceLabel={billingAvailability.founding.priceLabel}
          action={
            isAuthenticated ? (
              <Button
                variant="primary"
                loading={billingAction === "founding"}
                disabled={billingAction !== null}
                onClick={() => {
                  void startFoundingCheckout();
                }}
                fullWidth
              >
                Become a founding member
              </Button>
            ) : (
              <Link
                className="pricing-sign-in-link btn btn-primary btn-block"
                to="/account?upgrade=plus"
              >
                Sign in to claim
              </Link>
            )
          }
        />
      )}

      {currentPlan === "family" && (
        <Card variant="subtle" className="family-manage-card">
          <h2>Family Household</h2>
          <p>Manage household members, invites, and your shared recipe book.</p>
          <ButtonLink to="/household">Manage Household</ButtonLink>
        </Card>
      )}
    </div>
  );
};
