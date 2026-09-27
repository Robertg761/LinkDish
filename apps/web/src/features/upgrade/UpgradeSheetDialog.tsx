import React from "react";

import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { defaultBillingAvailability, PricingPlansContent } from "../pricing/plans-content";

import "./UpgradeSheet.css";

import type { UpgradeSheetTrigger } from "./UpgradeSheet";
import type { WebBillingTier } from "../billing/web-billing";
import type { PaidBillingPlan } from "@linkdish/api-contracts";

/**
 * The upgrade sheet's UI (and the plans content it shows). Loaded on demand the first time a
 * sheet is requested, so the app shell does not ship pricing UI to every visitor.
 */

const triggerCopy: Record<
  UpgradeSheetTrigger,
  {
    eyebrow: string;
    title: string;
    message: string;
  }
> = {
  family_share_no_plan: {
    eyebrow: "Family",
    message:
      "Family keeps the shared cookbook, household sync, and kitchen handoffs in one calm place.",
    title: "Share the kitchen when your plan is ready."
  },
  fourth_import_month: {
    eyebrow: "One left",
    message:
      "You are close to this month's free imports. Plus keeps the recipe flow open when dinner ideas are arriving fast.",
    title: "Keep saving the good finds."
  },
  import_limit: {
    eyebrow: "Limit reached",
    message:
      "Upgrade when you want more monthly imports, saved recipes, and a cookbook that follows you back to the stove.",
    title: "More room for the recipes worth keeping."
  },
  save_limit: {
    eyebrow: "Cookbook full",
    message:
      "You have 15 recipes saved on Free. Plus and Family keep every good find close, with unlimited saved recipes.",
    title: "Your free cookbook is full."
  }
};

export interface UpgradeSheetDialogProps {
  currentPlan: WebBillingTier;
  isAuthenticated: boolean;
  onDismiss: () => void;
  trigger: UpgradeSheetTrigger;
}

export const UpgradeSheetDialog: React.FC<UpgradeSheetDialogProps> = ({
  currentPlan,
  isAuthenticated,
  onDismiss,
  trigger
}) => {
  const copy = triggerCopy[trigger];

  const renderPlanActions = (checkoutPlan: PaidBillingPlan) => {
    if (currentPlan === checkoutPlan) {
      return (
        <Button variant="outline" disabled fullWidth>
          Active Plan
        </Button>
      );
    }

    return (
      <ButtonLink
        to={
          isAuthenticated ? `/pricing?upgrade=${checkoutPlan}` : `/account?upgrade=${checkoutPlan}`
        }
        variant={checkoutPlan === "family" ? "secondary" : "primary"}
        fullWidth
      >
        {isAuthenticated ? "Choose plan" : "Sign in to upgrade"}
      </ButtonLink>
    );
  };

  return (
    <div className="upgrade-sheet-backdrop" role="presentation">
      <section
        aria-labelledby="upgrade-sheet-title"
        aria-modal="true"
        className="upgrade-sheet"
        role="dialog"
      >
        <div className="upgrade-sheet-header">
          <div>
            <p className="upgrade-sheet-eyebrow">{copy.eyebrow}</p>
            <h2 id="upgrade-sheet-title">{copy.title}</h2>
          </div>
          <button
            aria-label="Dismiss upgrade"
            className="upgrade-sheet-close"
            onClick={onDismiss}
            type="button"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <p className="upgrade-sheet-message">{copy.message}</p>
        <PricingPlansContent
          billingAvailability={defaultBillingAvailability}
          currentPlan={currentPlan}
          renderPlanActions={renderPlanActions}
          showFreePlan={false}
        />
      </section>
    </div>
  );
};
