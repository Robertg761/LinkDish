import React from "react";

import { isCachedUserPremium } from "../../auth/auth-cache";
import { useAuth } from "../../auth/AuthProvider";
import { useSavedRecipes } from "../../data/library-store";
import { getWebBillingTier } from "../billing/web-billing";

import { BackupCard } from "./BackupCard";
import { ImportCard } from "./ImportCard";
import { StorageCard } from "./StorageCard";
import { useLocalDataCounts } from "./use-device-storage";

import "./YourDataSection.css";

/**
 * Settings → Your data: back up (JSON backup or Markdown), import (LinkDish backups, Paprika,
 * Mela, schema.org JSON-LD) and what LinkDish stores on this device. The heavy import/export code
 * loads only when someone uses it.
 */
export const YourDataSection: React.FC = () => {
  const { user, loading } = useAuth();
  const { recipes, status } = useSavedRecipes();
  const counts = useLocalDataCounts();
  const tier = getWebBillingTier(user);
  // While the session is still loading, trust the last known plan so a Plus cook isn't capped.
  const isPremium = tier !== "free" || (loading && !user && isCachedUserPremium());

  return (
    <div className="settings-data">
      <BackupCard
        collectionCount={counts?.collections ?? null}
        mealPlanCount={counts?.mealPlanEntries ?? null}
        recipes={recipes}
        recipesReady={status === "ready"}
      />
      <ImportCard isPremium={isPremium} />
      <StorageCard counts={counts} isFamily={tier === "family"} />
    </div>
  );
};
