import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorizeExtractionRequest: vi.fn() }));

vi.mock("../../billing/enforce-billing.js", () => ({
  authorizeExtractionRequest: mocks.authorizeExtractionRequest
}));

import { runCompleteRecipePipeline } from "./complete-recipe-pipeline";

import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";
import type { RecipeCompleter } from "../completion/gemini-recipe-completer";
import type { ExtractorRuntime } from "../types";

const recipe: Recipe = {
  title: "Broccoli Cheddar Soup",
  sourceUrl: "https://www.facebook.com/reel/28203918889307565/",
  sourceType: "social",
  image: null,
  ingredients: [{ text: "broccoli" }, { text: "cheddar cheese" }],
  steps: [{ index: 1, text: "Simmer the broccoli and melt in the cheese." }],
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

const completedRecipe: Recipe = {
  ...recipe,
  ingredients: [{ text: "3 cups broccoli" }, { text: "8 oz cheddar cheese" }],
  completion: {
    status: "ai_filled",
    ingredients: ["broccoli", "cheddar cheese"],
    filledAt: "2026-11-03T12:00:00.000Z"
  }
};

const quota = {
  limit: 3,
  remaining: 1,
  monthlyLimit: null,
  remainingThisMonth: null,
  resetsAt: null,
  meteringMode: "free_lifetime" as const
};

const logger = { info: vi.fn(), warn: vi.fn() };

const runtimeWith = (completer: RecipeCompleter): ExtractorRuntime =>
  ({ recipeCompleter: completer }) as unknown as ExtractorRuntime;

const completer = (complete: RecipeCompleter["complete"]): RecipeCompleter => ({
  available: true,
  model: "gemini-test",
  complete: vi.fn(complete)
});

const run = (runtime: ExtractorRuntime) =>
  runCompleteRecipePipeline({
    payload: { recipe },
    headers: { "x-linkdish-client-id": "client-1" },
    identity: { remoteAddress: "203.0.113.1" },
    startedAt: Date.now(),
    runtime,
    logger
  });

describe("runCompleteRecipePipeline", () => {
  const commitUsageWithQuota = vi.fn();
  const releaseUsage = vi.fn();

  beforeEach(() => {
    mocks.authorizeExtractionRequest.mockReset();
    commitUsageWithQuota.mockReset();
    releaseUsage.mockReset();
    commitUsageWithQuota.mockImplementation((response: { status: string }) =>
      Promise.resolve({ logContext: {}, quota: response.status === "success" ? quota : null })
    );
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: true,
      commitUsage: vi.fn(),
      commitUsageWithQuota,
      releaseUsage,
      logContext: {}
    });
  });

  it("meters the completion like a photo scan and returns the completed recipe with the quota", async () => {
    const response = await run(runtimeWith(completer(() => Promise.resolve(completedRecipe))));

    expect(mocks.authorizeExtractionRequest).toHaveBeenCalledWith(
      { "x-linkdish-client-id": "client-1" },
      "fallback",
      { remoteAddress: "203.0.113.1" }
    );
    expect(response).toMatchObject({
      status: "success",
      recipe: { completion: { status: "ai_filled" } },
      extraction: { strategy: "llm-fallback", provenance: ["llm"] },
      quota
    });
    expect(commitUsageWithQuota).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("gives the allowance back when Gemini has no usable answer", async () => {
    const response = await run(runtimeWith(completer(() => Promise.resolve(null))));

    expect(response).toMatchObject({ status: "failure", reason: "fallback_failed" });
    /* commitUsageWithQuota keeps usage only for a success; a failure is released there. */
    expect(commitUsageWithQuota).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure" })
    );
  });

  it("releases the allowance and rethrows when the completer throws", async () => {
    await expect(
      run(runtimeWith(completer(() => Promise.reject(new Error("cancelled")))))
    ).rejects.toThrow("cancelled");
    expect(releaseUsage).toHaveBeenCalledTimes(1);
  });

  it("returns billing's denial without calling Gemini", async () => {
    const denial = {
      status: "failure",
      reason: "quota_exceeded",
      userMessage: "You've used your free imports."
    };
    mocks.authorizeExtractionRequest.mockResolvedValue({
      allowed: false,
      response: denial,
      commitUsage: vi.fn(),
      logContext: {}
    });
    const complete = vi.fn(() => Promise.resolve(completedRecipe));

    await expect(
      run(runtimeWith({ available: true, model: "gemini-test", complete }))
    ).resolves.toEqual(denial);
    expect(complete).not.toHaveBeenCalled();
  });

  it("says AI is unavailable, without metering, when there is no Gemini key", async () => {
    const response = await run(
      runtimeWith({ available: false, model: null, complete: () => Promise.resolve(null) })
    );

    expect(response).toMatchObject({ status: "failure", reason: "fallback_unavailable" });
    expect(mocks.authorizeExtractionRequest).not.toHaveBeenCalled();
  });
});
