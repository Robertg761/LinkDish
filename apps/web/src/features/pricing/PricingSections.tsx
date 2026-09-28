import React from "react";
import { Link } from "react-router-dom";

import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import { SegmentedControl } from "../../components/SegmentedControl";

import { planComparisonRows, planContent } from "./plans-content";

import type { IconName } from "../../components/Icon";
import type { SegmentedOption } from "../../components/SegmentedControl";
import type { WebBillingTier } from "../billing/web-billing";
import type { BillingPeriod } from "@linkdish/api-contracts";

import "./PricingSections.css";

export const SUPPORT_EMAIL = "support@linkdish.ca";

const PERIOD_OPTIONS: ReadonlyArray<SegmentedOption<BillingPeriod>> = [
  { label: "Monthly", value: "monthly" },
  { label: "Yearly", value: "yearly" }
];

interface BillingPeriodToggleProps {
  value: BillingPeriod;
  onChange: (period: BillingPeriod) => void;
  bestSavings: number | null;
  size?: "sm" | "md" | undefined;
}

export const BillingPeriodToggle: React.FC<BillingPeriodToggleProps> = ({
  value,
  onChange,
  bestSavings,
  size = "md"
}) => (
  <div className="billing-period-toggle">
    <SegmentedControl
      aria-label="Billing period"
      onChange={onChange}
      options={PERIOD_OPTIONS}
      size={size}
      value={value}
    />
    {bestSavings ? (
      <Badge appearance="soft" className="billing-period-savings" icon="sparkles" tone="butter">
        Yearly saves up to {bestSavings}%
      </Badge>
    ) : null}
  </div>
);

const TIERS: ReadonlyArray<WebBillingTier> = ["free", "plus", "family"];

const ComparisonValue: React.FC<{ value: string | boolean }> = ({ value }) => {
  if (value === true) {
    return (
      <span className="plan-compare-yes">
        <Icon name="check" size={18} strokeWidth={2.6} />
        <span className="sr-only">Included</span>
      </span>
    );
  }

  if (value === false) {
    return (
      <span className="plan-compare-no">
        <Icon name="minus" size={16} />
        <span className="sr-only">Not included</span>
      </span>
    );
  }

  return <span className="plan-compare-text num">{value}</span>;
};

export const PlanComparisonTable: React.FC<{ currentPlan: WebBillingTier }> = ({ currentPlan }) => (
  <section aria-labelledby="plan-compare-title" className="pricing-section">
    <div className="pricing-section-heading">
      <h2 className="pricing-section-title" id="plan-compare-title">
        Compare plans
      </h2>
      <p className="pricing-section-lede">
        Every plan cooks the same. Paid plans give you more room and more people.
      </p>
    </div>
    <div className="plan-compare-wrap">
      <table className="plan-compare">
        <caption className="sr-only">What each LinkDish plan includes</caption>
        <thead>
          <tr>
            <td className="plan-compare-corner" />
            {TIERS.map((tier) => (
              <th
                className={[
                  "plan-compare-plan",
                  tier === "plus" ? "is-featured" : "",
                  tier === currentPlan ? "is-current" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={tier}
                scope="col"
              >
                {planContent[tier].name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {planComparisonRows.map((row) => (
            <tr key={row.label}>
              <th className="plan-compare-feature" scope="row">
                <span className="plan-compare-label">{row.label}</span>
                {row.hint ? <span className="plan-compare-hint">{row.hint}</span> : null}
              </th>
              {TIERS.map((tier) => (
                <td className={tier === "plus" ? "is-featured" : undefined} key={tier}>
                  <ComparisonValue value={row.values[tier]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

const TRUST_ITEMS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    body: "No contracts. Stop whenever you like.",
    icon: "calendar-check",
    title: "Cancel anytime"
  },
  {
    body: "Just your recipes, on every plan.",
    icon: "sparkles",
    title: "No ads"
  },
  {
    body: "Everything you save stays, even if you cancel.",
    icon: "shield-check",
    title: "Your recipes stay yours"
  }
];

export const PricingTrustRow: React.FC = () => (
  <ul aria-label="Our promises" className="pricing-trust">
    {TRUST_ITEMS.map((item) => (
      <li className="pricing-trust-item" key={item.title}>
        <span className="pricing-trust-icon">
          <Icon name={item.icon} size={20} />
        </span>
        <span className="pricing-trust-copy">
          <strong>{item.title}</strong>
          <span>{item.body}</span>
        </span>
      </li>
    ))}
  </ul>
);

const FAQ_ITEMS: ReadonlyArray<{ question: string; answer: React.ReactNode }> = [
  {
    answer: (
      <>
        Each time LinkDish reads a new recipe for you from a link, a video or a photo, that&apos;s
        one import. Opening, editing, cooking from or sharing recipes you&apos;ve already saved
        never counts, and an import that fails doesn&apos;t count either.
      </>
    ),
    question: "What counts as an import?"
  },
  {
    answer: (
      <>
        They stay right where they are. Everything you&apos;ve saved remains in your cookbook. You
        go back to Free limits for new imports and saves, so you can keep cooking from all of it and
        add more once you have room.
      </>
    ),
    question: "What happens to my recipes if I cancel?"
  },
  {
    answer: (
      <>
        Yes, with Family. Start a household, invite up to five people by email, and everyone shares
        one cookbook, one shopping list and the household&apos;s 250 monthly imports.{" "}
        <Link to="/household">See how households work</Link>.
      </>
    ),
    question: "Can I share with family?"
  },
  {
    answer: (
      <>
        On the web, choose <strong>Manage billing</strong> on this page while signed in. If you
        subscribed in the Android app, cancel in Google Play. Stuck? Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we&apos;ll sort it out.
      </>
    ),
    question: "How do I cancel?"
  }
];

export const PricingFaq: React.FC = () => (
  <section aria-labelledby="pricing-faq-title" className="pricing-section">
    <div className="pricing-section-heading">
      <h2 className="pricing-section-title" id="pricing-faq-title">
        Questions, answered
      </h2>
    </div>
    <div className="pricing-faq">
      {FAQ_ITEMS.map((item) => (
        <details className="pricing-faq-item" key={item.question}>
          <summary>
            <span>{item.question}</span>
            <Icon className="pricing-faq-chevron" name="chevron-down" size={20} />
          </summary>
          <p className="pricing-faq-answer">{item.answer}</p>
        </details>
      ))}
    </div>
    <p className="pricing-support-line">
      Still wondering? <a href={`mailto:${SUPPORT_EMAIL}`}>Email {SUPPORT_EMAIL}</a> or visit{" "}
      <Link to="/support">Support</Link>.
    </p>
  </section>
);

interface FoundingOfferCardProps {
  action: React.ReactNode;
  priceLabel: string;
}

export const FoundingOfferCard: React.FC<FoundingOfferCardProps> = ({ action, priceLabel }) => (
  <section aria-labelledby="founding-offer-title" className="founding-offer-card">
    <div className="founding-offer-copy">
      <Badge appearance="solid" icon="gem" tone="butter">
        Founding member
      </Badge>
      <h2 className="founding-offer-title" id="founding-offer-title">
        Founding Plus
      </h2>
      <p className="founding-offer-lede">
        Everything in Plus, forever. One payment, no subscription.
      </p>
    </div>
    <div className="founding-offer-buy">
      <p className="founding-offer-price">
        <span className="founding-offer-price-amount num">{priceLabel}</span>
        <span className="founding-offer-price-note">once</span>
      </p>
      {action}
    </div>
  </section>
);
