import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";

import { getMobileAnalyticsHeaders, trackMobileEvent } from "../analytics/client";
import { mobileEnv } from "../config/env";
import { buildMockExtractionResponse } from "../mocks/extraction";

import type { ExtractRecipeRequest, ExtractRecipeResponse } from "@linkdish/api-contracts";

const apiClient = createExtractorApiClient({
  baseUrl: mobileEnv.apiBaseUrl,
  getHeaders: getMobileAnalyticsHeaders
});

const TRANSIENT_STATUS_CODES = new Set([408, 429]);
const EXTRACTOR_RETRY_DELAY_MS = 750;

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

export const shouldRetryTransientExtractionError = (error: unknown) => {
  if (error instanceof ExtractorApiError) {
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

export function extractRecipe(
  url: string,
  attempt?: "primary" | "fallback",
  options?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse>;
export function extractRecipe(
  request: ExtractRecipeRequest,
  options?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse>;
export async function extractRecipe(
  requestOrUrl: ExtractRecipeRequest | string,
  attemptOrOptions: "primary" | "fallback" | ExtractRecipeOptions = "primary",
  maybeOptions?: ExtractRecipeOptions
): Promise<ExtractRecipeResponse> {
  const request =
    typeof requestOrUrl === "string"
      ? { url: requestOrUrl, attempt: attemptOrOptions as "primary" | "fallback" }
      : requestOrUrl;
  const options =
    typeof requestOrUrl === "string" ? maybeOptions : (attemptOrOptions as ExtractRecipeOptions);

  if (mobileEnv.useMockApi) {
    return buildMockExtractionResponse(request);
  }

  const client =
    options?.billingClientId || options?.authToken
      ? createExtractorApiClient({
          baseUrl: mobileEnv.apiBaseUrl,
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

  trackMobileEvent({
    eventName: "android_extract_submitted",
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    routeOrScreen: "recipe",
    properties: {
      attempt: request.attempt,
      input_mode: "images" in request ? "image" : "url",
      source_type: "images" in request ? "image" : "unknown"
    }
  });

  const operation = () => client.extractRecipe(request);
  const response = await runExtractorRequestWithRetry(operation);

  if (shouldRetryRetryableExtractionFailure(response)) {
    await wait(EXTRACTOR_RETRY_DELAY_MS);
    return operation();
  }

  return response;
}
