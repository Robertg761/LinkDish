import type { ExtractRecipeImage, QuotaStatus } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

export type ExtractionUiState =
  | { state: "empty" }
  | { state: "loading"; attempt: "primary" | "fallback" }
  | {
      state: "success";
      recipe: Recipe;
      sourceImages?: ExtractRecipeImage[] | undefined;
      strategy: string;
      warnings: string[];
      fetchMode: "http" | "browser";
      provenance: string[];
    }
  | {
      state: "retryable";
      reason: string;
      message: string;
      url: string;
      allowFallback: boolean;
      suggestedAction: "retry_primary" | "retry_fallback" | "try_another_url" | "try_again_later";
    }
  | {
      state: "failure";
      reason: string;
      message: string;
      allowFallback: boolean;
      quota?: QuotaStatus | undefined;
      suggestedAction: "retry_primary" | "retry_fallback" | "try_another_url" | "try_again_later";
    };

export type SuccessfulExtractionState = Extract<ExtractionUiState, { state: "success" }>;
