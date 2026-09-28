import { recordAdminExtractionEvent } from "../../admin/metrics.js";
import { recordDurableExtractionAnalyticsEvent } from "../../analytics/extraction-analytics.js";
import { authorizeExtractionRequest } from "../../billing/enforce-billing.js";
import { isAuthorizedCanaryRequest } from "../../request-identity.js";

import { extractRecipe } from "./extract-recipe.js";

import type {
  ExtractRecipeAnyRequest,
  ExtractRecipeResponse
} from "../../../../../../packages/api-contracts/src/index.js";
import type { AdminExtractionEventInput } from "../../admin/metrics.js";
import type { RequestHeaders, RequestIdentity } from "../../request-identity.js";
import type { ExtractorRuntime } from "../types.js";

export interface ExtractPipelineLogger {
  info(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
}

export interface ExtractRequestPipelineInput {
  payload: ExtractRecipeAnyRequest;
  headers: RequestHeaders;
  identity: RequestIdentity;
  startedAt: number;
  runtime?: ExtractorRuntime;
  /**
   * Keeps post-response work (durable analytics, cache and hand-off writes)
   * alive after the response is sent: Vercel's waitUntil in api/extract.ts,
   * fire-and-forget on the long-lived Fastify server.
   */
  schedule: (task: Promise<unknown>) => void;
  /** Extra structured-log fields, e.g. the rate-limit context. */
  logContext?: Record<string, unknown>;
  logger: ExtractPipelineLogger;
}

export interface ExtractRequestPipelineResult {
  response: ExtractRecipeResponse;
  headers: Record<string, string>;
}

const billingUnavailableResponse: ExtractRecipeResponse = {
  status: "failure",
  reason: "plan_limit",
  userMessage:
    "LinkDish could not verify your recipe allowance right now. Please try again in a moment.",
  recovery: {
    retryable: true,
    allowFallback: false,
    suggestedAction: "try_again_later"
  }
};

const recordAnalytics = (
  input: ExtractRequestPipelineInput,
  event: AdminExtractionEventInput
): void => {
  const correlationId = input.payload.correlationId;

  /* In-process dashboard metrics (recent requests, p95) must never fail an import. */
  try {
    recordAdminExtractionEvent(event);
  } catch (error) {
    input.logger.warn({
      event: "admin_extraction_metrics_failed",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }

  input.schedule(
    recordDurableExtractionAnalyticsEvent(input.headers, event, {
      ...(correlationId ? { correlationId } : {})
    }).catch((error: unknown) => {
      input.logger.warn({
        event: "durable_extraction_analytics_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    })
  );
};

/*
 * Pasted text always goes to the AI extractor, so it is metered like an explicit fallback
 * attempt (imports and strong extractions) whatever the request's attempt says.
 */
const getBillingAttempt = (payload: ExtractRecipeAnyRequest): "primary" | "fallback" =>
  "text" in payload ? "fallback" : payload.attempt;

/**
 * POST /extract after rate limiting and request parsing, shared by the Vercel
 * adapter and the Fastify route.
 *
 * Billing authorization and the extraction start together: URL validation, the
 * cache lookup and the page fetch overlap the billing lookups, and the
 * extraction is cancelled (its fetch aborted) if billing denies. Anything that
 * costs money or real CPU waits for billing's answer. Usage is still committed
 * before responding, exactly as before; analytics run after the response.
 */
export const runExtractRequestPipeline = async (
  input: ExtractRequestPipelineInput
): Promise<ExtractRequestPipelineResult> => {
  const { payload, headers } = input;
  const correlationId = payload.correlationId;
  const cancellation = new AbortController();
  const billingAttempt = getBillingAttempt(payload);
  const billingAuthorization = authorizeExtractionRequest(headers, billingAttempt, input.identity);
  const extraction = extractRecipe(payload, input.runtime, {
    signal: cancellation.signal,
    authorization: billingAuthorization.then(
      (authorization) => authorization.allowed,
      () => false
    ),
    ...(correlationId ? { correlationId } : {}),
    /*
     * Only the token-verified canary may read around the shared cache and refresh it. The bare
     * x-linkdish-canary marker is caller-controlled and changes nothing here.
     */
    cacheMode: isAuthorizedCanaryRequest(headers) ? "refresh" : "default",
    schedule: input.schedule
  });

  /* The extraction may settle before billing does; never leave its rejection unhandled. */
  void extraction.catch(() => undefined);

  const cancelExtraction = () => {
    cancellation.abort(new Error("Billing did not authorize this extraction."));
  };

  let billing: Awaited<typeof billingAuthorization>;

  try {
    billing = await billingAuthorization;
  } catch (error) {
    cancelExtraction();
    throw error;
  }

  if (!billing.allowed) {
    cancelExtraction();

    const latencyMs = Date.now() - input.startedAt;
    const analyticsEvent: AdminExtractionEventInput = {
      extraction: null,
      billing: billing.logContext,
      latencyMs,
      blockedReason:
        billing.response?.status === "failure" ? billing.response.reason : "billing_denied"
    };

    recordAnalytics(input, analyticsEvent);
    input.logger.warn({
      ...billing.logContext,
      ...input.logContext,
      attempt: billingAttempt,
      outcomeStatus: "failure",
      latencyMs
    });

    return {
      response: billing.response ?? billingUnavailableResponse,
      headers: {}
    };
  }

  const { response: extractionResponse, logContext } = await extraction;
  const committed = billing.commitUsageWithQuota
    ? await billing.commitUsageWithQuota(extractionResponse)
    : { logContext: await billing.commitUsage(extractionResponse), quota: null };
  const billingLogContext = committed.logContext;
  /* The allowance left after this import, for clients that show "2 imports left". */
  const response: ExtractRecipeResponse =
    extractionResponse.status === "success" && committed.quota
      ? { ...extractionResponse, quota: committed.quota }
      : extractionResponse;
  const latencyMs = Date.now() - input.startedAt;
  const analyticsEvent: AdminExtractionEventInput = {
    extraction: logContext,
    billing: billingLogContext,
    latencyMs
  };

  recordAnalytics(input, analyticsEvent);
  input.logger.info({
    ...billingLogContext,
    ...input.logContext,
    ...logContext,
    latencyMs
  });

  return {
    response,
    headers: logContext.cacheStatus ? { "x-linkdish-cache": logContext.cacheStatus } : {}
  };
};
