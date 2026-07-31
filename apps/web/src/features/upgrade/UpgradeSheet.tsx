import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { trackWebEvent } from "../../analytics/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { getWebBillingTier } from "../billing/web-billing";
import {
  defaultBillingAvailability,
  PricingPlansContent
} from "../pricing/plans-content";

import "./UpgradeSheet.css";

import type { PaidBillingPlan } from "@linkdish/api-contracts";

export type UpgradeSheetTrigger =
  | "family_share_no_plan"
  | "fourth_import_month"
  | "import_limit"
  | "save_limit";

interface UpgradeSheetContextValue {
  requestUpgradeSheet: (trigger: UpgradeSheetTrigger) => boolean;
}

const UpgradeSheetContext = createContext<UpgradeSheetContextValue | null>(null);
const SESSION_KEY_PREFIX = "linkdish:web:upgrade-sheet-viewed:";

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

const hasViewedTrigger = (trigger: UpgradeSheetTrigger, viewedInMemory: Set<UpgradeSheetTrigger>) => {
  if (viewedInMemory.has(trigger)) {
    return true;
  }

  try {
    return sessionStorage.getItem(`${SESSION_KEY_PREFIX}${trigger}`) === "true";
  } catch {
    return false;
  }
};

const markViewedTrigger = (
  trigger: UpgradeSheetTrigger,
  viewedInMemory: Set<UpgradeSheetTrigger>
) => {
  viewedInMemory.add(trigger);

  try {
    sessionStorage.setItem(`${SESSION_KEY_PREFIX}${trigger}`, "true");
  } catch {
    // Session storage is an enhancement; in-memory suppression still handles this page load.
  }
};

interface UpgradeSheetProviderProps {
  children: React.ReactNode;
}

export const UpgradeSheetProvider: React.FC<UpgradeSheetProviderProps> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [activeTrigger, setActiveTrigger] = useState<UpgradeSheetTrigger | null>(null);
  const viewedTriggersRef = useRef<Set<UpgradeSheetTrigger>>(new Set());
  const currentPlan = getWebBillingTier(user);

  const requestUpgradeSheet = useCallback(
    (trigger: UpgradeSheetTrigger) => {
      if (
        activeTrigger ||
        hasViewedTrigger(trigger, viewedTriggersRef.current) ||
        currentPlan !== "free"
      ) {
        return false;
      }

      markViewedTrigger(trigger, viewedTriggersRef.current);
      setActiveTrigger(trigger);
      trackWebEvent({
        eventName: "upgrade_viewed",
        routeOrScreen: window.location.pathname,
        properties: {
          trigger
        }
      });
      return true;
    },
    [activeTrigger, currentPlan]
  );

  const contextValue = useMemo(
    () => ({
      requestUpgradeSheet
    }),
    [requestUpgradeSheet]
  );

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
        to={isAuthenticated ? `/pricing?upgrade=${checkoutPlan}` : `/account?upgrade=${checkoutPlan}`}
        variant={checkoutPlan === "family" ? "secondary" : "primary"}
        fullWidth
      >
        {isAuthenticated ? "Choose plan" : "Sign in to upgrade"}
      </ButtonLink>
    );
  };

  const copy = activeTrigger ? triggerCopy[activeTrigger] : null;

  return (
    <UpgradeSheetContext.Provider value={contextValue}>
      {children}
      {activeTrigger && copy ? (
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
                onClick={() => setActiveTrigger(null)}
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
      ) : null}
    </UpgradeSheetContext.Provider>
  );
};

export const useUpgradeSheet = (): UpgradeSheetContextValue => {
  const context = useContext(UpgradeSheetContext);

  if (!context) {
    return {
      requestUpgradeSheet: () => false
    };
  }

  return context;
};
