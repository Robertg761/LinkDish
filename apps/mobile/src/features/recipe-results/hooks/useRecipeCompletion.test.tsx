import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("../../../services/extractor-api", () => ({ completeRecipe: vi.fn() }));

const accountMocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  isSignedIn: false
}));

vi.mock("../../account/AccountContext", () => ({ useAccount: () => accountMocks }));

const billingMocks = vi.hoisted(() => ({
  canStartStrongExtraction: vi.fn(),
  revenueCatAppUserId: "rc-user-1",
  spendImport: vi.fn(),
  spendStrongExtraction: vi.fn()
}));

vi.mock("../../billing/BillingContext", () => ({ useBilling: () => billingMocks }));

import { completeRecipe } from "../../../services/extractor-api";

import { useRecipeCompletion } from "./useRecipeCompletion";

import type { Recipe } from "@linkdish/recipe-domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedCompleteRecipe = vi.mocked(completeRecipe);

const recipe: Recipe = {
  title: "Broccoli Cheddar Soup",
  sourceUrl: "https://www.facebook.com/reel/28203918889307565/",
  sourceType: "social",
  image: null,
  ingredients: [{ text: "broccoli" }, { text: "cheddar cheese" }],
  steps: [{ index: 1, text: "Simmer and melt in the cheese." }],
  servings: null,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  nutrition: null,
  confidence: {
    score: 0.6,
    summary: "Read from the video.",
    missingFields: [],
    notes: [],
    fieldProvenance: {
      title: "llm",
      ingredients: "llm",
      steps: "llm",
      servings: null,
      prepTimeMinutes: null,
      cookTimeMinutes: null,
      nutrition: null
    }
  },
  completion: { status: "missing_amounts", ingredients: ["broccoli", "cheddar cheese"] }
};

const filled: Recipe = {
  ...recipe,
  ingredients: [{ text: "3 cups broccoli" }, { text: "8 oz cheddar cheese" }],
  completion: {
    status: "ai_filled",
    ingredients: ["broccoli", "cheddar cheese"],
    filledAt: "2026-11-03T12:00:00.000Z"
  }
};

const success = {
  status: "success" as const,
  recipe: filled,
  extraction: {
    sourceType: "social" as const,
    strategy: "llm-fallback" as const,
    confidenceScore: 0.6,
    missingFields: [],
    warnings: [],
    fetchMode: "http" as const,
    provenance: ["llm" as const]
  }
};

const renderHook = () => {
  const result: { current: ReturnType<typeof useRecipeCompletion> | null } = { current: null };
  const Probe = () => {
    result.current = useRecipeCompletion();
    return null;
  };

  act(() => {
    create(<Probe />);
  });

  return result;
};

describe("useRecipeCompletion", () => {
  beforeEach(() => {
    mockedCompleteRecipe.mockReset();
    accountMocks.getAuthToken.mockReset();
    accountMocks.getAuthToken.mockResolvedValue("token-1");
    accountMocks.isSignedIn = false;
    billingMocks.canStartStrongExtraction.mockReset();
    billingMocks.canStartStrongExtraction.mockReturnValue({ allowed: true });
    billingMocks.spendImport.mockReset();
    billingMocks.spendStrongExtraction.mockReset();
  });

  it("returns the filled recipe and spends one AI import on the device when signed out", async () => {
    mockedCompleteRecipe.mockResolvedValue(success);
    const hook = renderHook();

    let outcome: Awaited<ReturnType<ReturnType<typeof useRecipeCompletion>["fill"]>> | undefined;
    await act(async () => {
      outcome = await hook.current!.fill(recipe);
    });

    expect(outcome).toEqual({ status: "filled", recipe: filled });
    expect(mockedCompleteRecipe).toHaveBeenCalledWith(recipe, {
      authToken: "token-1",
      billingClientId: "rc-user-1"
    });
    expect(billingMocks.spendImport).toHaveBeenCalledTimes(1);
    expect(billingMocks.spendStrongExtraction).toHaveBeenCalledTimes(1);
  });

  it("leaves metering to the API when signed in", async () => {
    accountMocks.isSignedIn = true;
    mockedCompleteRecipe.mockResolvedValue(success);
    const hook = renderHook();

    await act(async () => {
      await hook.current!.fill(recipe);
    });

    expect(billingMocks.canStartStrongExtraction).not.toHaveBeenCalled();
    expect(billingMocks.spendStrongExtraction).not.toHaveBeenCalled();
  });

  it("does not call the API when the device's AI allowance is used up", async () => {
    billingMocks.canStartStrongExtraction.mockReturnValue({
      allowed: false,
      message: "You've used this month's AI imports."
    });
    const hook = renderHook();

    let outcome: Awaited<ReturnType<ReturnType<typeof useRecipeCompletion>["fill"]>> | undefined;
    await act(async () => {
      outcome = await hook.current!.fill(recipe);
    });

    expect(outcome).toEqual({ status: "failed", message: "You've used this month's AI imports." });
    expect(mockedCompleteRecipe).not.toHaveBeenCalled();
  });

  it("passes the API's message on, and spends nothing, when AI can't fill it in", async () => {
    mockedCompleteRecipe.mockResolvedValue({
      status: "failure",
      reason: "fallback_failed",
      userMessage: "LinkDish couldn't fill in this recipe just now. Please try again in a moment."
    });
    const hook = renderHook();

    let outcome: Awaited<ReturnType<ReturnType<typeof useRecipeCompletion>["fill"]>> | undefined;
    await act(async () => {
      outcome = await hook.current!.fill(recipe);
    });

    expect(outcome).toEqual({
      status: "failed",
      message: "LinkDish couldn't fill in this recipe just now. Please try again in a moment."
    });
    expect(billingMocks.spendStrongExtraction).not.toHaveBeenCalled();
  });

  it("says it couldn't fill the recipe when the request throws", async () => {
    mockedCompleteRecipe.mockRejectedValue(new Error("Network request failed"));
    const hook = renderHook();

    let outcome: Awaited<ReturnType<ReturnType<typeof useRecipeCompletion>["fill"]>> | undefined;
    await act(async () => {
      outcome = await hook.current!.fill(recipe);
    });

    expect(outcome).toMatchObject({ status: "failed" });
    expect(hook.current!.isFilling).toBe(false);
  });
});
