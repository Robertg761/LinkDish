import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import { Platform } from "react-native";

import { getMobileAnalyticsHeaders, trackMobileEvent } from "../analytics/client";
import { mobileEnv } from "../config/env";
import { requireAiConsent } from "../features/privacy/ai-consent";
import { getRecipeSourceRestriction } from "../features/recipe-intake/iosRecipeSources";
import { buildMockCompletionResponse, buildMockExtractionResponse } from "../mocks/extraction";

import { isTextExtractionRequest, type MobileExtractionRequest } from "./extraction-request";

import type { CompleteRecipeResponse, ExtractRecipeResponse } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

export type { MobileExtractionRequest, TextExtractionRequest } from "./extraction-request";

const apiClient = createExtractorApiClient({
  baseUrl: mobileEnv.apiBaseUrl,
  extractPath: Platform.OS === "ios" ? "/extract/ios" : "/extract",
  getHeaders: getMobileAnalyticsHeaders
});

const TRANSIENT_STATUS_CODES = new Set([408, 429]);
const EXTRACTOR_RETRY_DELAY_MS = 750;

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

export const shouldRetryTransientExtractionError = (error: unknown) => {
  // Network failures now arrive as ExtractorApiError (kind "network", status 0); they keep
  // their original message, so they still take the "Network request failed" check below.
  if (error instanceof ExtractorApiError && error.kind !== "network") {
    return error.statusCode >= 500 || TRANSIENT_STATUS_CODES.has(error.statusCode);
  }

  return error instanceof Error && error.message.trim() === "Network request failed";
};

export const shouldRetryRetryableExtractionFailure = (response: ExtractRecipeResponse): boolean =>
  response.status === "failure" &&
  response.recovery?.retryable === true &&
  response.recovery.suggestedAction === "retry_primary";

export const shouldRetryRetryablePrimaryFailure = shouldRetryRetryableExtractionFailure;

export const runExtractorRequestWithRetry = async <Response>(
  operation: () => Promise<Response>,
  options?: {
    waitForRetry?: (durationMs: number) => Promise<void>;
  }
): Promise<Response> => {
  try {
    return await operation();
  } catch (error) {
    if (!shouldRetryTransientExtractionError(error)) {
      throw error;
    }

    await (options?.waitForRetry ?? wait)(EXTRACTOR_RETRY_DELAY_MS);
    return operation();
  }
};

interface ExtractRecipeOptions {
  authToken?: string | null;
  billingClientId?: string | null;
}

/* A call that counts against the person's allowance names who they are to billing. */
const getBillingClient = (options: ExtractRecipeOptions | undefined) =>
  options?.billingClientId || options?.authToken
    ? createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        extractPath: Platform.OS === "ios" ? "/extract/ios" : "/extract",
        getHeaders: async () => {
          const analyticsHeaders = await getMobileAnalyticsHeaders();

          return {
            ...analyticsHeaders,
            ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
            "x-linkdish-billing-provider": "revenuecat",
            "x-linkdish-client-id":
              options.billingClientId ??
              analyticsHeaders["x-linkdish-client-id"] ??
              (await getMobileAnalyticsHeaders())["x-linkdish-client-id"]!
          };
        }
      })
    : apiClient;

/**
 * Asks AI to fill a saved recipe's gaps (amounts a video never stated). Metered like a photo
 * scan; the answer has /extract's shape.
 */
export const completeRecipe = async (
  recipe: Recipe,
  options?: ExtractRecipeOptions
): Promise<CompleteRecipeResponse> => {
  if (mobileEnv.useMockApi) {
    return buildMockCompletionResponse(recipe);
  }

  await requireAiConsent();
  return runExtractorRequestWithRetry(() => getBillingClient(options).completeRecipe({ recipe }));
};

export function extractRecipe(
  url: string,
  attempt?: "primary" | "fallback",
  options?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse>;
export function extractRecipe(
  request: MobileExtractionRequest,
  options?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse>;
export async function extractRecipe(
  requestOrUrl: MobileExtractionRequest | string,
  attemptOrOptions: "primary" | "fallback" | ExtractRecipeOptions = "primary",
  maybeOptions?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse> {
  const request: MobileExtractionRequest =
    typeof requestOrUrl === "string"
      ? { url: requestOrUrl, attempt: attemptOrOptions as "primary" | "fallback" }
      : requestOrUrl;
  const options =
    typeof requestOrUrl === "string" ? maybeOptions : (attemptOrOptions as ExtractRecipeOptions);

  // Covers pasted URLs, share/deep links and retries before any extraction request or quota use.
  if ("url" in request) {
    const restriction = getRecipeSourceRestriction(request.url, Platform.OS);
    if (restriction) {
      return { status: "failure", reason: "unsupported_source", userMessage: restriction };
    }
  }

  if (mobileEnv.useMockApi) {
    return buildMockExtractionResponse(request);
  }

  await requireAiConsent();
  const client = getBillingClient(options);

  trackMobileEvent({
    eventName: "android_extract_submitted",
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    routeOrScreen: "recipe",
    properties: {
      attempt: request.attempt,
      input_mode: isTextExtractionRequest(request) ? "text" : "images" in request ? "image" : "url",
      source_type: isTextExtractionRequest(request)
        ? "text"
        : "images" in request
          ? "image"
          : "unknown"
    }
  });

  const operation = async (): Promise<ExtractRecipeResponse> => {
    const result = await (isTextExtractionRequest(request)
      ? client.extractRecipeFromText({
          attempt: request.attempt,
          text: request.text,
          ...(request.correlationId ? { correlationId: request.correlationId } : {}),
          ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {})
        })
      : client.extractRecipe(request));
    // Also refuse to display/save a URL extraction redirected outside the source list.
    // The server must separately enforce the policy before fetching redirect destinations.
    if ("url" in request && result.status === "success") {
      const restriction = getRecipeSourceRestriction(result.recipe.sourceUrl, Platform.OS);
      if (restriction) {
        return { status: "failure", reason: "unsupported_source", userMessage: restriction };
      }
    }
    return result;
  };
  const response = await runExtractorRequestWithRetry(operation);

  if (shouldRetryRetryableExtractionFailure(response)) {
    await wait(EXTRACTOR_RETRY_DELAY_MS);
    return operation();
  }

  return response;
}
