import { ZodError } from "zod";

import { extractRecipeRequestSchema } from "../packages/api-contracts/src/index.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { recordDurableExtractionAnalyticsEvent } from "../services/extractor-api/src/modules/analytics/extraction-analytics.js";
import { authorizeExtractionRequest } from "../services/extractor-api/src/modules/billing/enforce-billing.js";
import { extractRecipe } from "../services/extractor-api/src/modules/extract/services/extract-recipe.js";
import {
  checkExtractRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 60
};

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestIdentity = getVercelRequestIdentity(request);

  try {
    const rateLimit = await checkExtractRateLimit(request.headers, requestIdentity);

    if (!rateLimit.allowed) {
      console.warn(
        JSON.stringify({
          ...rateLimit.logContext,
          outcomeStatus: "rate_limited",
          latencyMs: Date.now() - startedAt
        })
      );

      return corsJson(
        request,
        {
          message: "Too many extract requests. Please try again shortly."
        },
        {
          headers: rateLimit.headers,
          status: 429
        }
      );
    }

    const payload = extractRecipeRequestSchema.parse(await request.json());
    const billingAuthorization = await authorizeExtractionRequest(
      request.headers,
      payload.attempt,
      requestIdentity
    );

    if (!billingAuthorization.allowed) {
      const latencyMs = Date.now() - startedAt;
      await recordDurableExtractionAnalyticsEvent(
        request.headers,
        {
          extraction: null,
          billing: billingAuthorization.logContext,
          latencyMs,
          blockedReason:
            billingAuthorization.response?.status === "failure"
              ? billingAuthorization.response.reason
              : "billing_denied"
        },
        {
          ...(payload.correlationId ? { correlationId: payload.correlationId } : {})
        }
      ).catch((error) => {
        console.warn("Failed to record durable extraction analytics.", error);
      });

      console.warn(
        JSON.stringify({
          ...billingAuthorization.logContext,
          ...rateLimit.logContext,
          attempt: payload.attempt,
          outcomeStatus: "failure",
          latencyMs
        })
      );

      return corsJson(request, billingAuthorization.response, {
        status: 200
      });
    }

    const { response, logContext } = await extractRecipe(payload);
    const billingLogContext = await billingAuthorization.commitUsage(response);
    const latencyMs = Date.now() - startedAt;

    await recordDurableExtractionAnalyticsEvent(
      request.headers,
      {
        extraction: logContext,
        billing: billingLogContext,
        latencyMs
      },
      {
        ...(payload.correlationId ? { correlationId: payload.correlationId } : {})
      }
    ).catch((error) => {
      console.warn("Failed to record durable extraction analytics.", error);
    });

    console.info(
      JSON.stringify({
        ...billingLogContext,
        ...rateLimit.logContext,
        ...logContext,
        latencyMs
      })
    );

    return corsJson(request, response, {
      status: 200
    });
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      console.error(error);

      return corsJson(
        request,
        {
          message: "LinkDish could not verify request limits right now. Please try again shortly."
        },
        {
          headers: {
            "retry-after": "30"
          },
          status: 503
        }
      );
    }

    if (error instanceof ZodError) {
      return corsJson(
        request,
        {
          message: "Invalid extract request.",
          issues: error.issues
        },
        {
          status: 400
        }
      );
    }

    console.error(error);

    return corsJson(
      request,
      {
        message: "Unexpected extractor error."
      },
      {
        status: 500
      }
    );
  }
}
