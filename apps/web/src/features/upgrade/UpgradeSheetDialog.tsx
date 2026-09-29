import React, { useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "../../components/Badge";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { useSavedRecipes } from "../../data/library-store";
import { useWebBillingAvailability } from "../billing/billing-availability";
import { useWebCheckout } from "../billing/use-web-checkout";
import { webBillingPlans } from "../billing/web-billing";
import { describeFreeQuota } from "../library/components/free-quota";
import { countCookbook } from "../library/components/library-model";
import {
  getBestYearlySavings,
  getPlanPriceDisplay,
  getPurchasablePeriod,
  PAID_PLANS,
  planContent
} from "../pricing/plans-content";
import { BillingPeriodToggle } from "../pricing/PricingSections";

import type { UpgradeSheetTrigger } from "./UpgradeSheet";
import type { CheckoutTrigger } from "../billing/checkout-session";
import type { WebBillingTier } from "../billing/web-billing";
import type { BillingPeriod, PaidBillingPlan } from "@linkdish/api-contracts";

import "./UpgradeSheet.css";

/**
 * The upgrade sheet's UI. Loaded on demand the first time a sheet is requested, so the app shell
 * does not ship pricing UI to every visitor.
 */

interface TriggerCopy {
  eyebrow: string;
  title: string;
  message: string;
  benefits: [string, string, string];
  plan: PaidBillingPlan;
  /** upgrade_purchased trigger when a checkout starts from this sheet. */
  purchaseTrigger: CheckoutTrigger;
}

const triggerCopy: Record<UpgradeSheetTrigger, TriggerCopy> = {
  family_share_no_plan: {
    benefits: [
      "One cookbook the whole household can cook from",
      "A shopping list that stays in sync for everyone",
      "Up to 6 people and 250 imports a month"
    ],
    eyebrow: "Family",
    message: "Family turns your recipes into a shared kitchen for the people you cook with.",
    plan: "family",
    purchaseTrigger: "household",
    title: "Share the kitchen with Family."
  },
  fourth_import_month: {
    benefits: [
      "100 recipe imports every month",
      "Unlimited saved recipes",
      "Save from recipe sites, videos and photos"
    ],
    eyebrow: "Almost out",
    message: "You're nearly out of free imports. Plus keeps the good finds coming.",
    plan: "plus",
    purchaseTrigger: "import_limit",
    title: "Keep saving the good finds."
  },
  import_limit: {
    benefits: [
      "100 recipe imports every month",
      "Unlimited saved recipes",
      "Save from recipe sites, videos and photos"
    ],
    eyebrow: "Imports used",
    message:
      "You've used your free imports. Upgrade for a fresh batch every month and a cookbook with no ceiling.",
    plan: "plus",
    purchaseTrigger: "import_limit",
    title: "More room for the recipes worth keeping."
  },
  save_limit: {
    benefits: [
      "Unlimited saved recipes",
      "100 recipe imports every month",
      "Your saved recipes stay right where they are"
    ],
    eyebrow: "Cookbook full",
    message: "Your free cookbook is full. Upgrade to keep every good find close.",
    plan: "plus",
    purchaseTrigger: "unknown",
    title: "Your free cookbook is full."
  }
};

const FREE_SAVE_LIMIT =
  typeof webBillingPlans.free.limits.savedRecipes === "number"
    ? webBillingPlans.free.limits.savedRecipes
    : 15;

/**
 * The cookbook sheet says what the Cookbook's meter says: "nearly full" with the live count when
 * there is still room (the meter's Get Plus), "full" only when it is, and that starter recipes
 * don't count.
 */
const useSaveLimitCopy = (enabled: boolean, base: TriggerCopy): TriggerCopy => {
  const library = useSavedRecipes();

  if (!enabled || library.status !== "ready") {
    return base;
  }

  const quota = describeFreeQuota(countCookbook(library.recipes), FREE_SAVE_LIMIT);
  const starterNote = quota.starterNote ? ` ${quota.starterNote}` : "";
  const benefits: [string, string, string] = [
    base.benefits[0],
    base.benefits[1],
    `Your ${quota.saved} saved recipes stay right where they are`
  ];

  if (quota.state === "roomy") {
    return {
      ...base,
      benefits,
      eyebrow: "Free plan",
      message: `You've saved ${quota.saved} of ${quota.limit} free recipes.${starterNote} Plus gives every good find a place, with no limit.`,
      title: "Make your cookbook unlimited."
    };
  }

  if (quota.state === "nearly_full") {
    return {
      ...base,
      benefits,
      eyebrow: "Almost full",
      message: `You've saved ${quota.saved} of ${quota.limit} free recipes, so there's room for ${quota.remaining} more.${starterNote} Plus gives every good find a place.`,
      title: "Your cookbook is nearly full."
    };
  }

  const overNote = quota.over > 0 ? ` (${quota.over} over the limit, and they all stay)` : "";

  return {
    ...base,
    benefits,
    message: `${quota.valueText} on Free${overNote}.${starterNote} Upgrade to keep every good find close.`
  };
};

export interface UpgradeSheetDialogProps {
  currentPlan: WebBillingTier;
  isAuthenticated: boolean;
  /**
   * Whether the account a checkout started for is still signed in, answered by the provider: it
   * stays mounted when another account signs in (or out), while this sheet closes.
   */
  isCurrentAccount: (startedFor: string | null) => boolean;
  onDismiss: () => void;
  trigger: UpgradeSheetTrigger;
}

export const UpgradeSheetDialog: React.FC<UpgradeSheetDialogProps> = ({
  currentPlan,
  isAuthenticated,
  isCurrentAccount,
  onDismiss,
  trigger
}) => {
  const copy = useSaveLimitCopy(trigger === "save_limit", triggerCopy[trigger]);
  const [plan, setPlan] = useState<PaidBillingPlan>(copy.plan);
  const [period, setPeriod] = useState<BillingPeriod>("yearly");
  const availabilityView = useWebBillingAvailability();
  const { availability } = availabilityView;
  const checkout = useWebCheckout({ isCurrentAccount, trigger: copy.purchaseTrigger });
  const purchasablePeriod = getPurchasablePeriod(plan, period, availabilityView);
  const planName = planContent[plan].name;
  const pricingPath = `/pricing?upgrade=${plan}${period === "monthly" ? "&period=monthly" : ""}`;
  const busy = checkout.busyAction !== null;

  const primaryAction = !isAuthenticated ? (
    <ButtonLink
      onClick={onDismiss}
      to={`/account?upgrade=${plan}${period === "monthly" ? "&period=monthly" : ""}`}
      trailingIcon="arrow-right"
    >
      Sign in to upgrade
    </ButtonLink>
  ) : purchasablePeriod ? (
    <Button
      disabled={busy}
      loading={checkout.busyAction === `${plan}-${purchasablePeriod}`}
      onClick={() => {
        void checkout.startCheckout(plan, purchasablePeriod).then((outcome) => {
          if (outcome === "purchased") {
            onDismiss();
          }
        });
      }}
    >
      Upgrade to {planName}
    </Button>
  ) : availabilityView.status === "loading" ? (
    <Button loading>Upgrade to {planName}</Button>
  ) : (
    <ButtonLink onClick={onDismiss} to={pricingPath} trailingIcon="arrow-right">
      See plans
    </ButtonLink>
  );

  return (
    <Sheet
      className="upgrade-sheet"
      description={copy.message}
      dismissible={!busy}
      footer={
        <>
          <Button disabled={busy} onClick={onDismiss} variant="ghost">
            Not now
          </Button>
          {primaryAction}
        </>
      }
      onClose={onDismiss}
      open
      size="md"
      testId="upgrade-sheet"
      title={
        <>
          {/* Decorative: hidden from the dialog's accessible name, which is the headline. */}
          <span aria-hidden="true" className="upgrade-sheet-eyebrow">
            <Icon name={copy.plan === "family" ? "users" : "sparkles"} size={14} />
            {copy.eyebrow}
          </span>
          {copy.title}
        </>
      }
    >
      <ul className="upgrade-sheet-benefits">
        {copy.benefits.map((benefit) => (
          <li key={benefit}>
            <span className="upgrade-sheet-benefit-icon">
              <Icon name="check" size={16} strokeWidth={2.6} />
            </span>
            <span>{benefit}</span>
          </li>
        ))}
      </ul>

      <div className="upgrade-sheet-chooser">
        <BillingPeriodToggle
          bestSavings={getBestYearlySavings(availability)}
          onChange={setPeriod}
          size="sm"
          value={period}
        />

        <fieldset className="upgrade-sheet-plans">
          <legend className="sr-only">Choose a plan</legend>
          {PAID_PLANS.map((option) => {
            const price = getPlanPriceDisplay(option, period, availability);
            const selected = option === plan;
            const isCurrent = option === currentPlan;

            return (
              <label className={`upgrade-sheet-plan${selected ? " is-selected" : ""}`} key={option}>
                <input
                  aria-label={`${planContent[option].name}, ${price.amount}${price.unit}`}
                  checked={selected}
                  className="upgrade-sheet-plan-input"
                  disabled={isCurrent}
                  name="upgrade-sheet-plan"
                  onChange={() => setPlan(option)}
                  type="radio"
                  value={option}
                />
                <span className="upgrade-sheet-plan-radio" aria-hidden="true" />
                <span className="upgrade-sheet-plan-copy">
                  <span className="upgrade-sheet-plan-name">
                    {planContent[option].name}
                    {isCurrent ? (
                      <Badge tone="primary">Current</Badge>
                    ) : price.savingsPercent ? (
                      <Badge tone="success">Save {price.savingsPercent}%</Badge>
                    ) : null}
                  </span>
                  <span className="upgrade-sheet-plan-tagline">
                    {option === "family" ? "Up to 6 people" : "Just for you"}
                  </span>
                </span>
                <span className="upgrade-sheet-plan-price">
                  <span className="upgrade-sheet-plan-amount num">
                    {price.amount}
                    <span className="upgrade-sheet-plan-unit">{price.unit}</span>
                  </span>
                  <span className="upgrade-sheet-plan-note num">{price.note}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </div>

      {checkout.error ? (
        <p className="upgrade-sheet-error" role="alert">
          <Icon name="alert-circle" size={18} />
          <span>{checkout.error}</span>
        </p>
      ) : null}

      <p className="upgrade-sheet-fineprint">
        Cancel anytime. Everything you&apos;ve saved stays yours.{" "}
        <Link onClick={onDismiss} to={pricingPath}>
          Compare plans
        </Link>
      </p>
    </Sheet>
  );
};
