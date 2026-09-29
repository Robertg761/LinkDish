import { useCallback, useEffect, useRef, useState } from "react";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { requestSaveFeedback } from "../../lib/delight-events";
import { markRecipeSaved } from "../install/install-eligibility";
import {
  forceSaveRecipe,
  generateDeterministicId,
  SavedRecipeLimitError,
  saveRecipe,
  syncRecipeToHousehold
} from "../library/saved-recipe-store";
import { useShoppingAccount } from "../shopping/shopping-sync";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import type { SaveRecipeInput } from "../library/saved-recipe-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { V2AnalyticsSourceType } from "@linkdish/utils";

/**
 * "Save to cookbook" for an import. The recipe counts as saved the moment the local write lands
 * (instant, works offline); sharing it with the household happens afterwards in the background
 * and only shows up when there is a household to share with.
 */

export type ImportSaveStatus = "idle" | "saving" | "saved" | "duplicate" | "limit" | "error";
/** none: no household (or signed out) · sharing: in flight · shared · failed */
export type HouseholdShareStatus = "none" | "checking" | "sharing" | "shared" | "failed";

export interface ImportSave {
  status: ImportSaveStatus;
  savedRecipe: WebSavedRecipe | null;
  /** The id this recipe has (or will have) in the cookbook. */
  recipeId: string | null;
  error: string;
  household: HouseholdShareStatus;
  save: () => Promise<WebSavedRecipe | null>;
  replace: () => Promise<WebSavedRecipe | null>;
  retryShare: () => void;
  dismissDuplicate: () => void;
}

export const getImportSourceType = (
  input: Pick<SaveRecipeInput, "sourceImages" | "sourceUrl">
): V2AnalyticsSourceType =>
  input.sourceImages?.length
    ? "image"
    : input.sourceUrl.includes("linkdish.app/text-imports/")
      ? "text"
      : "url";

export function useSaveImport(
  input: SaveRecipeInput,
  options: { onSaved?: ((recipe: WebSavedRecipe) => void) | undefined } = {}
): ImportSave {
  const { isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const shopping = useShoppingAccount();
  const [status, setStatus] = useState<ImportSaveStatus>("idle");
  const [savedRecipe, setSavedRecipe] = useState<WebSavedRecipe | null>(null);
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [household, setHousehold] = useState<HouseholdShareStatus>("none");
  const mountedRef = useRef(true);
  const inputRef = useRef(input);
  inputRef.current = input;
  const onSavedRef = useRef(options.onSaved);
  onSavedRef.current = options.onSaved;
  const isPremium = user?.billingPlan === "plus" || user?.billingPlan === "family";
  const householdMode = shopping.mode;
  /** Who a save is for: its recipe is shared only as that account, and only while it's signed in. */
  const account = getAccountScope(isAuthenticated, user);
  const isCurrentAccount = useIsCurrentAccount(account);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    generateDeterministicId(input.sourceUrl, input.recipe.title).then(
      (id) => {
        if (!cancelled) {
          setRecipeId(id);
        }
      },
      () => undefined
    );

    return () => {
      cancelled = true;
    };
  }, [input.recipe.title, input.sourceUrl]);

  const share = useCallback(
    (recipe: WebSavedRecipe, sharedFor: string | null) => {
      // Someone else signed in (or out) while it saved: it isn't shared into their household.
      const isCurrent = () => isCurrentAccount(sharedFor);

      if (sharedFor === null || recipe.isStarter || !isCurrent()) {
        setHousehold("none");
        return;
      }

      // Only talk about the household when we already know there is one.
      setHousehold(householdMode === "household" ? "sharing" : "checking");
      void syncRecipeToHousehold(recipe, { isCurrent }).then(
        (synced) => {
          if (!mountedRef.current) {
            return;
          }

          if (!isCurrent()) {
            setHousehold("none");
            return;
          }

          setSavedRecipe(synced);
          setHousehold(
            synced.sync?.status === "synced"
              ? "shared"
              : synced.sync?.status === "sync_failed"
                ? "failed"
                : "none"
          );
        },
        () => {
          if (mountedRef.current) {
            setHousehold(isCurrent() ? "failed" : "none");
          }
        }
      );
    },
    [householdMode, isCurrentAccount]
  );

  const afterLocalSave = useCallback(
    (recipe: WebSavedRecipe, savedFor: string | null) => {
      const current = inputRef.current;
      setSavedRecipe(recipe);
      setRecipeId(recipe.id);
      setStatus("saved");
      setError("");
      trackWebV2AnalyticsEvent({
        name: "recipe_saved",
        properties: { source_type: getImportSourceType(current), surface: "import_result" },
        routeOrScreen: "/import"
      });
      markRecipeSaved();

      try {
        requestSaveFeedback();
      } catch {
        // Delight only.
      }

      onSavedRef.current?.(recipe);
      share(recipe, savedFor);
    },
    [share]
  );

  const handleLimit = useCallback(() => {
    setStatus("limit");
    setError("Your free cookbook is full: 15 recipes saved. Upgrade for unlimited recipes.");
    requestUpgradeSheet("save_limit");
  }, [requestUpgradeSheet]);

  const save = useCallback(async (): Promise<WebSavedRecipe | null> => {
    const savedFor = account;
    setStatus("saving");
    setError("");

    try {
      const result = await saveRecipe(inputRef.current, isPremium);

      if (result.success && result.recipe) {
        afterLocalSave(result.recipe, savedFor);
        return result.recipe;
      }

      if (result.error === "limit_exceeded") {
        handleLimit();
        return null;
      }

      setStatus(result.error === "duplicate_prompt" ? "duplicate" : "idle");
      return null;
    } catch (saveError) {
      if (saveError instanceof SavedRecipeLimitError) {
        handleLimit();
        return null;
      }

      console.error("Import save failed:", saveError);
      setStatus("error");
      setError(getFriendlyErrorMessage(saveError, "save"));
      return null;
    }
  }, [account, afterLocalSave, handleLimit, isPremium]);

  const replace = useCallback(async (): Promise<WebSavedRecipe | null> => {
    const savedFor = account;
    setStatus("saving");
    setError("");

    try {
      const recipe = await forceSaveRecipe(inputRef.current, isPremium);
      afterLocalSave(recipe, savedFor);
      return recipe;
    } catch (saveError) {
      // The recipe it replaced was deleted meanwhile, and the free cookbook is full again.
      if (saveError instanceof SavedRecipeLimitError) {
        handleLimit();
        return null;
      }

      console.error("Import replace failed:", saveError);
      setStatus("error");
      setError(getFriendlyErrorMessage(saveError, "save"));
      return null;
    }
  }, [account, afterLocalSave, handleLimit, isPremium]);

  const retryShare = useCallback(() => {
    if (savedRecipe) {
      share(savedRecipe, account);
    }
  }, [account, savedRecipe, share]);

  const dismissDuplicate = useCallback(() => setStatus("idle"), []);

  return {
    dismissDuplicate,
    error,
    household,
    recipeId,
    replace,
    retryShare,
    save,
    savedRecipe,
    status
  };
}
