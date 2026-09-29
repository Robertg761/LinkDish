import React from "react";

import { ButtonLink } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";

import type { WebBillingTier } from "../../billing/web-billing";

interface FamilyLockedPanelProps {
  tier: WebBillingTier;
}

/**
 * The Family tab for a signed-in cook without a household: what Family is and one clear next
 * step (start a household on a Family plan, see the plan otherwise), instead of a system notice.
 */
export const FamilyLockedPanel: React.FC<FamilyLockedPanelProps> = ({ tier }) => (
  <section aria-label="Family cookbook" className="library-family-locked">
    <EmptyState
      actions={
        tier === "family" ? (
          <ButtonLink icon="users" to="/household">
            Start a household
          </ButtonLink>
        ) : (
          <>
            <ButtonLink icon="users" to="/pricing?upgrade=family">
              See the Family plan
            </ButtonLink>
            <ButtonLink to="/household" variant="secondary">
              I have an invite
            </ButtonLink>
          </>
        )
      }
      body={
        tier === "family"
          ? "Your plan includes Family. Start a household, invite up to five people, and the recipes you share land here for everyone."
          : "One shared cookbook and one shopping list for up to 6 people. Join a household with an invite, or start one with the Family plan."
      }
      illustration="cookbook"
      title="Cook together with Family"
    />
  </section>
);
