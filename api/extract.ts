import { waitUntil } from "@vercel/functions";
import { ZodError } from "zod";

import { extractRecipeAnyRequestSchema } from "../packages/api-contracts/src/index.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { runExtractRequestPipeline } from "../services/extractor-api/src/modules/extract/services/extract-request-pipeline.js";
import {
  checkExtractRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 60
};

const structuredLogger = {
  info: (entry: Record<string, unknown>) => console.info(JSON.stringify(entry)),
  warn: (entry: Record<string, unknown>) => console.warn(JSON.stringify(entry))
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

    const payload = extractRecipeAnyRequestSchema.parse(await request.json());
    /*
     * Durable analytics and the extraction cache/hand-off writes run after the
     * response through waitUntil, so the recipe is returned as soon as usage
     * is committed.
     */
    const { response, headers } = await runExtractRequestPipeline({
      payload,
      headers: request.headers,
      identity: requestIdentity,
      startedAt,
      schedule: (task) => {
        waitUntil(task);
      },
      logContext: rateLimit.logContext,
      logger: structuredLogger
    });

    return corsJson(request, response, {
      headers,
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
