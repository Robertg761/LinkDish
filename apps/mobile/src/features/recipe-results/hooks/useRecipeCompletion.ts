import { useCallback, useState } from "react";

import { completeRecipe } from "../../../services/extractor-api";
import { useAccount } from "../../account/AccountContext";
import { useBilling } from "../../billing/BillingContext";
import { AiConsentDeclinedError } from "../../privacy/ai-consent";

import type { Recipe } from "@linkdish/recipe-domain";

export type RecipeCompletionResult =
  { status: "filled"; recipe: Recipe } | { status: "failed"; message: string };

const genericFailure = "LinkDish couldn’t fill in this recipe just now. Please try again.";

/*
 * Asks AI to fill a saved recipe's gaps (amounts a video never stated). It is an AI import, so
 * it is gated like a photo scan: on the device when signed out, by the API when signed in.
 */
export const useRecipeCompletion = () => {
  const { canStartStrongExtraction, revenueCatAppUserId, spendImport, spendStrongExtraction } =
    useBilling();
  const { getAuthToken, isSignedIn } = useAccount();
  const [isFilling, setIsFilling] = useState(false);

  const fill = useCallback(
    async (recipe: Recipe): Promise<RecipeCompletionResult> => {
      const useServerBillingGate = isSignedIn;

      if (!useServerBillingGate) {
        const gate = canStartStrongExtraction();

        if (!gate.allowed) {
          return {
            status: "failed",
            message: gate.message ?? "This month's LinkDish usage limit has been reached."
          };
        }
      }

      setIsFilling(true);

      try {
        const authToken = await getAuthToken();
        const response = await completeRecipe(recipe, {
          authToken,
          billingClientId: revenueCatAppUserId
        });

        if (response.status !== "success") {
          return {
            status: "failed",
            message: response.status === "failure" ? response.userMessage : genericFailure
          };
        }

        if (!useServerBillingGate) {
          spendImport();
          spendStrongExtraction();
        }

        return { status: "filled", recipe: response.recipe };
      } catch (error) {
        return {
          status: "failed",
          message:
            error instanceof AiConsentDeclinedError
              ? "Nothing was sent for AI processing. Allow Gemini processing to fill in this recipe."
              : genericFailure
        };
      } finally {
        setIsFilling(false);
      }
    },
    [
      canStartStrongExtraction,
      getAuthToken,
      isSignedIn,
      revenueCatAppUserId,
      spendImport,
      spendStrongExtraction
    ]
  );

  return { fill, isFilling };
};
