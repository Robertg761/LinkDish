import React from "react";

import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";

import { getPlanPriceDisplay, planContent } from "./plans-content";

import type { WebBillingTier } from "../billing/web-billing";
import type { BillingPeriod, WebBillingAvailability } from "@linkdish/api-contracts";

import "./PlanCard.css";

interface PlanCardProps {
  tier: WebBillingTier;
  period: BillingPeriod;
  availability: WebBillingAvailability;
  isCurrent?: boolean | undefined;
  isRecommended?: boolean | undefined;
  /** The plan the person arrived asking about (?upgrade=). */
  isSelected?: boolean | undefined;
  /** Call to action or plan status, rendered under the price. */
  action?: React.ReactNode;
  /** Extra content between the action and the feature list, e.g. a usage meter. */
  children?: React.ReactNode;
  ref?: React.Ref<HTMLElement> | undefined;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  tier,
  period,
  availability,
  isCurrent = false,
  isRecommended = false,
  isSelected = false,
  action,
  children,
  ref
}) => {
  const copy = planContent[tier];
  const price = getPlanPriceDisplay(tier, period, availability);
  const nameId = `plan-card-${tier}-name`;

  return (
    <article
      aria-labelledby={nameId}
      className={[
        "plan-card",
        `plan-card-${tier}`,
        isRecommended ? "plan-card-featured" : "",
        isCurrent ? "is-current" : "",
        isSelected ? "is-selected" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      data-plan={tier}
      ref={ref}
    >
      <div className="plan-card-badges">
        {isCurrent ? (
          <Badge appearance="solid" icon="check" tone="primary">
            Current plan
          </Badge>
        ) : null}
        {isRecommended && !isCurrent ? (
          <Badge appearance="solid" icon="star-filled" tone="butter">
            Recommended
          </Badge>
        ) : null}
      </div>

      <header className="plan-card-header">
        <h2 className="plan-card-name" id={nameId}>
          {copy.name}
        </h2>
        <p className="plan-card-tagline">{copy.tagline}</p>
      </header>

      <div className="plan-card-price">
        <p className="plan-card-amount-row">
          <span className="plan-card-amount num">{price.amount}</span>
          {price.unit ? <span className="plan-card-unit">{price.unit}</span> : null}
        </p>
        <p className="plan-card-note">
          <span>{price.note}</span>
          {price.savingsPercent ? (
            <Badge className="plan-card-savings" tone="success">
              Save {price.savingsPercent}%
            </Badge>
          ) : null}
        </p>
      </div>

      {action ? <div className="plan-card-action">{action}</div> : null}
      {children}

      <ul className="plan-card-features">
        {copy.highlights.map((feature) => (
          <li key={`${feature.emphasis ?? ""}${feature.text}`}>
            <Icon className="plan-card-check" name="check" size={18} strokeWidth={2.4} />
            <span>
              {feature.emphasis ? <strong>{feature.emphasis}</strong> : null}
              {feature.text}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
};

interface PlanStatusProps {
  icon?: React.ComponentProps<typeof Icon>["name"] | undefined;
  children: React.ReactNode;
  tone?: "default" | "muted" | undefined;
}

/** A quiet status line where a card has no action, e.g. "Your current plan". */
export const PlanStatus: React.FC<PlanStatusProps> = ({ icon, children, tone = "default" }) => (
  <p className={`plan-status plan-status-${tone}`}>
    {icon ? <Icon name={icon} size={18} /> : null}
    <span>{children}</span>
  </p>
);
