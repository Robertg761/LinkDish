import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { ingestAnalyticsBatch } from "../services/extractor-api/src/modules/analytics/ingest-analytics-batch.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 10
};

const analyticsRateLimitPolicy = {
  max: 180,
  scope: "analytics",
  windowMs: 60 * 1_000
} as const;

const logger = {
  warn: (message: string, details: Record<string, unknown>) => {
    console.warn(message, JSON.stringify(details));
  }
};

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  let rateLimit;

  try {
    rateLimit = await checkPublicEndpointRateLimit(
      request.headers,
      analyticsRateLimitPolicy,
      getVercelRequestIdentity(request)
    );
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return corsJson(
        request,
        {
          message: "Analytics ingestion is temporarily unavailable."
        },
        {
          status: 503
        }
      );
    }

    throw error;
  }

  if (!rateLimit.allowed) {
    return corsJson(
      request,
      {
        message: "Too many analytics requests."
      },
      {
        headers: rateLimit.headers,
        status: 429
      }
    );
  }

  const result = await ingestAnalyticsBatch(
    await request.json().catch(() => null),
    request.headers,
    logger
  );

  if (result.kind === "invalid") {
    return corsJson(
      request,
      {
        message: result.message,
        issues: result.issues
      },
      {
        status: 400
      }
    );
  }

  return corsJson(request, result.body);
}
