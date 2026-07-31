import React from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { formatMonthlyQuotaCopy, type MonthlyQuotaFields } from "../billing/quota-copy";
import { type WebBillingTier, webBillingPlans } from "../billing/web-billing";
import "./PricingPage.css";

import type {
  BillingPeriod,
  PaidBillingPlan,
  WebBillingAvailability
} from "@linkdish/api-contracts";

export const defaultBillingAvailability: WebBillingAvailability = {
  managementPortalAvailable: false,
  plans: {
    family: {
      monthly: false,
      yearly: false
    },
    plus: {
      monthly: false,
      yearly: false
    }
  },
  prices: {
    family: {
      monthly: "$4.99/month",
      yearly: "$44.99/year"
    },
    plus: {
      monthly: "$2.99/month",
      yearly: "$24.99/year"
    }
  },
  webCheckoutEnabled: false
};

export const getCheckoutButtonLabel = (period: BillingPeriod, price: string): string =>
  `${period === "monthly" ? "Monthly" : "Yearly"} - ${price}`;

export const getMonthlyDisplayAmount = (price: string): string =>
  price.replace(/^\$/u, "").replace(/\/month$/u, "");

type PlanFeature = {
  emphasis?: string;
  text: string;
};

export const planContent: Record<
  WebBillingTier,
  {
    features: PlanFeature[];
    name: string;
    priceAmount: (availability: WebBillingAvailability) => string;
  }
> = {
  family: {
    features: [
      { emphasis: "250", text: " recipe imports per month" },
      { emphasis: "Unlimited", text: " saved recipes" },
      { text: "Clean ad-free recipe view" },
      { text: "Saved recipes available offline" },
      { emphasis: "Household Sharing", text: " (up to 6 members)" },
      { text: "Real-time shared recipe syncing" }
    ],
    name: "Family",
    priceAmount: (availability) => getMonthlyDisplayAmount(availability.prices.family.monthly)
  },
  free: {
    features: [
      { emphasis: "3", text: " recipe imports total" },
      { emphasis: "15", text: " saved recipes free" },
      { text: "Clean ad-free recipe view" }
    ],
    name: "Free",
    priceAmount: () => "0"
  },
  plus: {
    features: [
      { emphasis: "100", text: " recipe imports per month" },
      { emphasis: "Unlimited", text: " saved recipes" },
      { text: "Clean ad-free recipe view" },
      { text: "Saved recipes available offline" },
      { text: "Better recovery for difficult recipe pages" }
    ],
    name: "Plus",
    priceAmount: (availability) => getMonthlyDisplayAmount(availability.prices.plus.monthly)
  }
};

export type PlanActionsRenderer = (
  checkoutPlan: PaidBillingPlan,
  prices: Record<BillingPeriod, string>
) => React.ReactNode;

interface UsageSummaryCardProps {
  currentPlan: WebBillingTier;
  isAuthenticated: boolean;
  monthlyQuota?: MonthlyQuotaFields | null | undefined;
  remainingImports: number | null;
}

export const UsageSummaryCard: React.FC<UsageSummaryCardProps> = ({
  currentPlan,
  isAuthenticated,
  monthlyQuota,
  remainingImports
}) => {
  const plan = webBillingPlans[currentPlan];
  const fallbackUsage = isAuthenticated
    ? currentPlan === "free"
      ? `${plan.limits.monthlyImports} total limit`
      : `${plan.limits.monthlyImports} monthly limit`
    : `${remainingImports} of ${plan.limits.monthlyImports}`;
  const usageCopy = formatMonthlyQuotaCopy(monthlyQuota, fallbackUsage);

  return (
    <Card variant="subtle" className="usage-summary-card">
      <h2>{currentPlan === "free" ? "Free Usage" : "This Month"}</h2>
      <div className="usage-summary-grid">
        <div>
          <span>Plan</span>
          <strong>{plan.displayName}</strong>
        </div>
        <div>
          <span>{isAuthenticated ? "Recipe imports" : "Recipe imports left"}</span>
          <strong>{usageCopy}</strong>
        </div>
      </div>
      {isAuthenticated && (
        <p className="usage-summary-note">
          Signed-in usage is checked by the LinkDish API when you import a recipe.
        </p>
      )}
    </Card>
  );
};

interface PricingPlansContentProps {
  billingAvailability: WebBillingAvailability;
  currentPlan: WebBillingTier;
  renderPlanActions?: PlanActionsRenderer;
  showFreePlan?: boolean;
}

const renderFeatures = (tier: WebBillingTier) => (
  <ul className="plan-features">
    {planContent[tier].features.map((feature) => (
      <li key={`${feature.emphasis ?? ""}${feature.text}`}>
        {feature.emphasis ? <strong>{feature.emphasis}</strong> : null}
        {feature.text}
      </li>
    ))}
  </ul>
);

interface FoundingOfferCardProps {
  action: React.ReactNode;
  priceLabel: string;
}

export const FoundingOfferCard: React.FC<FoundingOfferCardProps> = ({ action, priceLabel }) => (
  <Card variant="default" className="founding-offer-card">
    <p className="founding-offer-eyebrow">Founding member</p>
    <h2 className="founding-offer-title">Founding Plus</h2>
    <p className="founding-offer-lede">
      Everything in Plus, forever. One payment, no subscription.
    </p>
    <div className="founding-offer-price">
      <span className="founding-offer-price-amount">{priceLabel}</span>
      <span className="founding-offer-price-note">once</span>
    </div>
    {renderFeatures("plus")}
    {action}
  </Card>
);

export const PricingPlansContent: React.FC<PricingPlansContentProps> = ({
  billingAvailability,
  currentPlan,
  renderPlanActions,
  showFreePlan = true
}) => {
  const tiers: WebBillingTier[] = showFreePlan ? ["free", "plus", "family"] : ["plus", "family"];

  return (
    <div className="pricing-grid">
      {tiers.map((tier) => {
        const isCurrentPlan = currentPlan === tier;
        const isPaidPlan = tier === "plus" || tier === "family";

        return (
          <Card
            key={tier}
            variant={isCurrentPlan ? "default" : "subtle"}
            className={`pricing-card ${isCurrentPlan ? "current-plan" : ""}`}
          >
            {isCurrentPlan && (
              <Chip variant="accent" className="current-plan-badge-chip">
                Your Current Plan
              </Chip>
            )}
            <h2 className="plan-name">{planContent[tier].name}</h2>
            <div className="plan-price">
              <span className="price-symbol">$</span>
              <span className="price-amount">
                {planContent[tier].priceAmount(billingAvailability)}
              </span>
              <span className="price-period">/month</span>
            </div>
            {renderFeatures(tier)}
            {isPaidPlan && renderPlanActions ? (
              renderPlanActions(tier, billingAvailability.prices[tier])
            ) : (
              <Button variant="outline" disabled={isCurrentPlan} fullWidth>
                {isCurrentPlan ? "Active Plan" : "Free Tier"}
              </Button>
            )}
          </Card>
        );
      })}
    </div>
  );
};
