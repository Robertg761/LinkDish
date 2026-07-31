import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { EXTRACTION_ERROR_LINES } from "../../lib/flavor-copy";

import { ExtractPage } from "./ExtractPage";

import type { ExtractRecipeRequest } from "@linkdish/api-contracts";

const apiClientMocks = vi.hoisted(() => ({
  extractRecipe: vi.fn<(request: ExtractRecipeRequest) => Promise<unknown>>()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    extractRecipe: apiClientMocks.extractRecipe
  },
  ExtractorApiError: class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
      this.name = "ExtractorApiError";
    }
  }
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    loading: false,
    user: {
      billingPlan: "plus",
      email: "cook@example.com",
      id: "user_1"
    }
  })
}));

vi.mock("../../platform/detect-network", () => ({
  addNetworkListeners: () => () => undefined,
  isOnline: () => true
}));

describe("ExtractPage", () => {
  beforeEach(() => {
    apiClientMocks.extractRecipe.mockReset();
    vi.mocked(trackWebV2AnalyticsEvent).mockClear();
    vi.mocked(trackWebEvent).mockClear();
    apiClientMocks.extractRecipe.mockResolvedValue({
      reason: "not_recipe",
      status: "failure",
      userMessage: "No recipe could be found at that link."
    });
  });

  it("emits import_failed with the failure reason on a terminal failure response", async () => {
    render(
      <MemoryRouter>
        <ExtractPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/my-recipe"), {
      target: { value: "https://example.com/recipe" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract recipe" }));

    await waitFor(() => {
      expect(trackWebV2AnalyticsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "import_failed",
          properties: expect.objectContaining({
            failure_reason: "not_recipe",
            source_type: "url"
          }) as Record<string, unknown>
        })
      );
    });

    const submittedRequest = apiClientMocks.extractRecipe.mock.calls[0]?.[0];
    if (!submittedRequest) {
      throw new Error("Expected an extraction request.");
    }
    const failedEvent = vi
      .mocked(trackWebV2AnalyticsEvent)
      .mock.calls.find(([event]) => event.name === "import_failed")?.[0];
    expect(submittedRequest.correlationId).toBeTruthy();
    expect(failedEvent?.correlationId).toBe(submittedRequest.correlationId);
  });

  it("keeps one correlation ID across a user-approved fallback attempt", async () => {
    apiClientMocks.extractRecipe
      .mockResolvedValueOnce({
        status: "needs_retry",
        reason: "low_confidence",
        sourceType: "article",
        suggestedAttempt: "fallback",
        userMessage: "Try a deeper extraction.",
        diagnostics: {
          confidenceScore: 0.5,
          missingFields: ["ingredients"]
        }
      })
      .mockResolvedValueOnce({
        reason: "fallback_failed",
        status: "failure",
        userMessage: "The deeper extraction failed."
      });

    render(
      <MemoryRouter>
        <ExtractPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/my-recipe"), {
      target: { value: "https://example.com/recipe" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract recipe" }));

    fireEvent.click(await screen.findByRole("button", { name: "Try Deeper Extraction" }));

    await waitFor(() => {
      expect(apiClientMocks.extractRecipe).toHaveBeenCalledTimes(2);
    });

    const primaryRequest = apiClientMocks.extractRecipe.mock.calls[0]?.[0];
    const fallbackRequest = apiClientMocks.extractRecipe.mock.calls[1]?.[0];
    if (!primaryRequest || !fallbackRequest) {
      throw new Error("Expected primary and fallback requests.");
    }
    expect(fallbackRequest.correlationId).toBe(primaryRequest.correlationId);
    expect(
      vi.mocked(trackWebEvent).mock.calls.filter(([event]) => event.eventName === "import_started")
    ).toHaveLength(1);
    expect(trackWebV2AnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: primaryRequest.correlationId,
        name: "import_needs_retry"
      })
    );
  });

  it("records abandonment once and ignores a late response after unmount", async () => {
    let resolveExtraction: ((response: unknown) => void) | undefined;
    apiClientMocks.extractRecipe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveExtraction = resolve;
        })
    );
    const view = render(
      <MemoryRouter>
        <ExtractPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/my-recipe"), {
      target: { value: "https://example.com/slow-recipe" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract recipe" }));

    await waitFor(() => {
      expect(apiClientMocks.extractRecipe).toHaveBeenCalledOnce();
    });
    view.unmount();

    expect(trackWebV2AnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "import_abandoned",
        properties: expect.objectContaining({
          abandonment_reason: "page_unmounted"
        }) as Record<string, unknown>
      })
    );

    await act(async () => {
      resolveExtraction?.({
        reason: "parse_failed",
        status: "failure",
        userMessage: "Late failure"
      });
      await Promise.resolve();
    });

    expect(
      vi
        .mocked(trackWebV2AnalyticsEvent)
        .mock.calls.filter(([event]) => event.name === "import_failed")
    ).toHaveLength(0);
  });

  it("uses the shared flavor-copy list for extraction error headlines", async () => {
    render(
      <MemoryRouter>
        <ExtractPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/my-recipe"), {
      target: { value: "https://example.com/recipe" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract recipe" }));

    await waitFor(() => {
      expect(apiClientMocks.extractRecipe).toHaveBeenCalled();
    });

    const alert = await screen.findByRole("alert");
    const headline = within(alert).getByRole("heading", { level: 3 });

    expect(EXTRACTION_ERROR_LINES).toContain(headline.textContent);
    expect(screen.getByText("No recipe could be found at that link.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try another URL" })).toBeInTheDocument();
  });

  it("prefers monthly quota fields in extract limit errors when present", async () => {
    apiClientMocks.extractRecipe.mockResolvedValue({
      quota: {
        limit: 5,
        meteringMode: "free_monthly_grandfathered",
        monthlyLimit: 5,
        remaining: 0,
        remainingThisMonth: 0,
        resetsAt: "2026-08-01T00:00:00.000Z"
      },
      reason: "quota_exceeded",
      status: "failure",
      userMessage: "Your free imports are gone."
    });

    render(
      <MemoryRouter>
        <ExtractPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByPlaceholderText("https://example.com/my-recipe"), {
      target: { value: "https://example.com/recipe" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Extract recipe" }));

    expect(await screen.findByText(/^0 of 5 left this month/u)).toBeInTheDocument();
  });
});
