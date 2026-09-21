import type { ExtractRecipeImage, QuotaStatus } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

/**
 * A scanned source photo as the app carries it around.
 *
 * `uri` is a `file://` URI once the scan has been written to disk, and may be a
 * `data:` URL while the scan is still in memory (straight off the import
 * request). `data:` URLs are never persisted - see `serializeSavedRecipeRecords`.
 */
export interface RecipeSourceImage {
  mimeType: ExtractRecipeImage["mimeType"];
  uri: string;
}

export type ExtractionUiState =
  | { state: "empty" }
  | { state: "loading"; attempt: "primary" | "fallback" }
  | {
      state: "success";
      recipe: Recipe;
      sourceImages?: RecipeSourceImage[] | undefined;
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
