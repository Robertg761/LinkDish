import { useEffect, useState } from "react";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { useSavedRecipe } from "../../data/library-store";
import { requestSaveFeedback } from "../../lib/delight-events";
import { markRecipeSaved } from "../install/install-eligibility";
import {
  forceSaveRecipe,
  generateDeterministicId,
  SavedRecipeLimitError,
  saveRecipe,
  syncRecipeToHousehold
} from "../library/saved-recipe-store";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import type { FeaturedRecipe } from "./types";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

export type FeaturedSaveStatus = "idle" | "saving" | "syncing" | "saved" | "duplicate" | "error";

export interface FeaturedSave {
  status: FeaturedSaveStatus;
  /** The copy in this browser's cookbook, when there is one. */
  savedRecipeId: string | null;
  error: string;
  syncWarning: string;
  save: () => Promise<void>;
  replace: () => Promise<void>;
  dismissDuplicate: () => void;
}

/**
 * "Save to my cookbook" for a featured recipe — the same rules as saving an import: the free
 * limit (upgrade sheet), a duplicate check with an optional replace, and a household sync when
 * signed in.
 */
export const useSaveFeaturedRecipe = (featured: FeaturedRecipe): FeaturedSave => {
  const { isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [status, setStatus] = useState<FeaturedSaveStatus>("idle");
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [deterministicId, setDeterministicId] = useState<string | null>(null);
  const { recipe: existing } = useSavedRecipe(deterministicId ?? undefined);
  const isPremium = user?.billingPlan === "plus" || user?.billingPlan === "family";
  /** Who a save is for: its recipe is shared only as that account, and only while it's signed in. */
  const account = getAccountScope(isAuthenticated, user);
  const isCurrentAccount = useIsCurrentAccount(account);
  const input = {
    extraction: featured.extraction,
    recipe: featured.recipe,
    sourceUrl: featured.sourceUrl
  };

  useEffect(() => {
    let cancelled = false;
    generateDeterministicId(featured.sourceUrl, featured.recipe.title).then(
      (id) => {
        if (!cancelled) {
          setDeterministicId(id);
        }
      },
      () => undefined
    );

    return () => {
      cancelled = true;
    };
  }, [featured.recipe.title, featured.sourceUrl]);

  const afterSave = async (saved: WebSavedRecipe, savedFor: string | null) => {
    trackWebV2AnalyticsEvent({
      name: "recipe_saved",
      properties: { source_type: "url", surface: "import_result" },
      routeOrScreen: "/"
    });
    // Someone else signed in (or out) while it saved: it isn't shared into their household.
    const isCurrent = () => isCurrentAccount(savedFor);

    if (savedFor !== null && isCurrent()) {
      setStatus("syncing");
      const synced = await syncRecipeToHousehold(saved, { isCurrent });

      if (isCurrent() && synced.sync?.status === "sync_failed") {
        setSyncWarning("Saved here. Household sync failed; you can retry from the recipe.");
      }
    }

    setStatus("saved");
    markRecipeSaved();

    try {
      requestSaveFeedback();
    } catch {
      // Delight only.
    }
  };

  const save = async () => {
    const savedFor = account;
    setStatus("saving");
    setError("");
    setSyncWarning("");

    try {
      const result = await saveRecipe(input, isPremium);

      if (result.success && result.recipe) {
        await afterSave(result.recipe, savedFor);
        return;
      }

      if (result.error === "limit_exceeded") {
        setStatus("error");
        setError("Your free cookbook is full: 15 recipes saved. Upgrade for unlimited recipes.");
        requestUpgradeSheet("save_limit");
        return;
      }

      setStatus(result.error === "duplicate_prompt" ? "duplicate" : "idle");
    } catch (saveError) {
      console.error("Featured save failed:", saveError);
      setStatus("error");
      setError(getFriendlyErrorMessage(saveError, "save"));
    }
  };

  const replace = async () => {
    const savedFor = account;
    setStatus("saving");
    setError("");

    try {
      await afterSave(await forceSaveRecipe(input, isPremium), savedFor);
    } catch (saveError) {
      // The recipe it replaced was deleted meanwhile, and the free cookbook is full again.
      if (saveError instanceof SavedRecipeLimitError) {
        setStatus("error");
        setError("Your free cookbook is full: 15 recipes saved. Upgrade for unlimited recipes.");
        requestUpgradeSheet("save_limit");
        return;
      }

      console.error("Featured replace failed:", saveError);
      setStatus("error");
      setError(getFriendlyErrorMessage(saveError, "save"));
    }
  };

  const dismissDuplicate = () => setStatus("idle");
  const alreadySaved = Boolean(existing) && status !== "duplicate";

  return {
    dismissDuplicate,
    error,
    replace,
    save,
    savedRecipeId: existing?.id ?? (status === "saved" ? deterministicId : null),
    status: alreadySaved && status === "idle" ? "saved" : status,
    syncWarning
  };
};
