import { authorizeExtractionRequest } from "../../billing/enforce-billing.js";
import { AI_FILLED_NOTE } from "../completion/gemini-recipe-completer.js";

import { getSharedExtractorRuntime } from "./runtime.js";

import type {
  CompleteRecipeRequest,
  CompleteRecipeResponse
} from "../../../../../../packages/api-contracts/src/index.js";
import type { RequestHeaders, RequestIdentity } from "../../request-identity.js";
import type { ExtractorRuntime } from "../types.js";
import type { ExtractPipelineLogger } from "./extract-request-pipeline.js";

export interface CompleteRecipePipelineInput {
  payload: CompleteRecipeRequest;
  headers: RequestHeaders;
  identity: RequestIdentity;
  startedAt: number;
  runtime?: ExtractorRuntime;
  logger: ExtractPipelineLogger;
}

/* Gemini gets this long to answer; the request deadline is the function's (60 s). */
const completionTimeoutMs = 40_000;

const failure = (
  reason: "fallback_unavailable" | "fallback_failed" | "plan_limit",
  userMessage: string,
  retryable: boolean
): CompleteRecipeResponse => ({
  status: "failure",
  reason,
  userMessage,
  recovery: {
    retryable,
    allowFallback: false,
    suggestedAction: retryable ? "try_again_later" : "try_another_url"
  }
});

const billingUnavailableResponse = failure(
  "plan_limit",
  "LinkDish could not verify your recipe allowance right now. Please try again in a moment.",
  true
);

/**
 * POST /recipes/complete after rate limiting and request parsing, shared by the Vercel adapter
 * and the Fastify route. It is an LLM call made on the person's request, so it is metered like a
 * photo scan (an import and a strong extraction): the allowance is reserved before Gemini is
 * called, kept for a completed recipe and given back for anything else.
 */
export const runCompleteRecipePipeline = async (
  input: CompleteRecipePipelineInput
): Promise<CompleteRecipeResponse> => {
  const runtime = input.runtime ?? getSharedExtractorRuntime();
  const completer = runtime.recipeCompleter;

  if (!completer?.available) {
    return failure(
      "fallback_unavailable",
      "Filling in recipes with AI isn't available right now. Please try again later.",
      true
    );
  }

  const billing = await authorizeExtractionRequest(input.headers, "fallback", input.identity);

  if (!billing.allowed) {
    input.logger.warn({
      ...billing.logContext,
      event: "recipe_completion",
      outcome: "billing_denied",
      latencyMs: Date.now() - input.startedAt
    });
    return billing.response ?? billingUnavailableResponse;
  }

  let completed: Awaited<ReturnType<typeof completer.complete>>;

  try {
    completed = await completer.complete(input.payload.recipe, { timeoutMs: completionTimeoutMs });
  } catch (error) {
    await billing.releaseUsage?.();
    throw error;
  }

  const response: CompleteRecipeResponse = completed
    ? {
        status: "success",
        recipe: completed,
        extraction: {
          sourceType: completed.sourceType,
          strategy: "llm-fallback",
          confidenceScore: completed.confidence.score,
          missingFields: completed.confidence.missingFields,
          warnings: [AI_FILLED_NOTE],
          fetchMode: "http",
          provenance: ["llm"]
        }
      }
    : failure(
        "fallback_failed",
        "LinkDish couldn't fill in this recipe just now. Please try again in a moment.",
        true
      );
  const committed = billing.commitUsageWithQuota
    ? await billing.commitUsageWithQuota(response)
    : { logContext: await billing.commitUsage(response), quota: null };

  input.logger.info({
    ...committed.logContext,
    event: "recipe_completion",
    model: completer.model,
    outcome: completed ? "completed" : "failed",
    ingredientCount: input.payload.recipe.ingredients.length,
    latencyMs: Date.now() - input.startedAt
  });

  return response.status === "success" && committed.quota
    ? { ...response, quota: committed.quota }
    : response;
};
