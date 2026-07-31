import { ExtractorApiError } from "@linkdish/api-client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../analytics/client", () => ({
  getMobileAnalyticsHeaders: () =>
    Promise.resolve({
      "x-linkdish-client-id": "test-client-id",
      "x-linkdish-platform": "android_app",
      "x-linkdish-session-id": "00000000-0000-4000-8000-000000000000"
    }),
  trackMobileEvent: vi.fn()
}));

import {
  runExtractorRequestWithRetry,
  shouldRetryRetryableExtractionFailure,
  shouldRetryRetryablePrimaryFailure,
  shouldRetryTransientExtractionError
} from "./extractor-api";

describe("extractor-api retry helpers", () => {
  it("retries once after a transient extractor server error", async () => {
    const response = {
      status: "success",
      recipe: {
        title: "Soup",
        sourceUrl: "https://example.com/soup",
        sourceType: "article",
        ingredients: [{ text: "1 onion" }],
        steps: [{ index: 1, text: "Cook." }],
        servings: "4 servings",
        prepTimeMinutes: 10,
        cookTimeMinutes: 20,
        nutrition: null,
        confidence: {
          score: 0.81,
          summary: "Confident extraction.",
          missingFields: [],
          notes: [],
          fieldProvenance: {
            title: "visible-text",
            ingredients: "visible-text",
            steps: "visible-text",
            servings: "visible-text",
            prepTimeMinutes: "visible-text",
            cookTimeMinutes: "visible-text",
            nutrition: null
          }
        }
      },
      extraction: {
        sourceType: "article",
        strategy: "article-pattern",
        confidenceScore: 0.81,
        missingFields: [],
        warnings: [],
        fetchMode: "http",
        provenance: ["readability", "visible-text"]
      }
    } as const;

    const operation = vi
      .fn<() => Promise<typeof response>>()
      .mockRejectedValueOnce(new ExtractorApiError("Extractor API request failed.", 500))
      .mockResolvedValueOnce(response);

    await expect(
      runExtractorRequestWithRetry(operation, {
        waitForRetry: () => Promise.resolve()
      })
    ).resolves.toEqual(response);

    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a stable client error", async () => {
    const error = new ExtractorApiError("Extractor API request failed.", 400);
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(
      runExtractorRequestWithRetry(operation, {
        waitForRetry: () => Promise.resolve()
      })
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("classifies transient request failures correctly", () => {
    expect(shouldRetryTransientExtractionError(new ExtractorApiError("Failed.", 503))).toBe(true);
    expect(shouldRetryTransientExtractionError(new ExtractorApiError("Failed.", 429))).toBe(true);
    expect(shouldRetryTransientExtractionError(new ExtractorApiError("Failed.", 422))).toBe(false);
    expect(shouldRetryTransientExtractionError(new Error("Network request failed"))).toBe(true);
  });

  it("classifies retryable primary API failures correctly", () => {
    const retryableFailure = {
      status: "failure",
      reason: "source_unreachable",
      userMessage: "We could not reach that source right now.",
      recovery: {
        retryable: true,
        allowFallback: false,
        suggestedAction: "retry_primary"
      }
    } as const;

    expect(shouldRetryRetryablePrimaryFailure(retryableFailure)).toBe(true);
    expect(shouldRetryRetryableExtractionFailure(retryableFailure)).toBe(true);

    expect(
      shouldRetryRetryablePrimaryFailure({
        status: "failure",
        reason: "plan_limit",
        userMessage: "LinkDish could not identify this app install.",
        recovery: {
          retryable: true,
          allowFallback: false,
          suggestedAction: "try_again_later"
        }
      })
    ).toBe(false);

    expect(
      shouldRetryRetryablePrimaryFailure({
        status: "needs_retry",
        reason: "low_confidence",
        sourceType: "article",
        suggestedAttempt: "fallback",
        userMessage: "Try again with more help.",
        diagnostics: {
          confidenceScore: 0.42,
          missingFields: []
        },
        recovery: {
          retryable: true,
          allowFallback: true,
          suggestedAction: "retry_fallback"
        }
      })
    ).toBe(false);
  });
});
