import { analyticsEventBatchRequestSchema } from "../packages/api-contracts/src/index.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import {
  hashAnalyticsUserId,
  sanitizeAnalyticsProperties
} from "../services/extractor-api/src/modules/analytics/analytics-privacy.js";
import { writeAnalyticsEvents } from "../services/extractor-api/src/modules/analytics/analytics-store.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";
import { getHeader } from "../services/extractor-api/src/modules/request-identity.js";

export const config = {
  maxDuration: 10
};

const analyticsRateLimitPolicy = {
  max: 180,
  scope: "analytics",
  windowMs: 60 * 1_000
} as const;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  let rateLimit;

  try {
    rateLimit = await checkPublicEndpointRateLimit(request.headers, analyticsRateLimitPolicy);
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

  const parsed = analyticsEventBatchRequestSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return corsJson(
      request,
      {
        message: "Invalid analytics event batch.",
        issues: parsed.error.issues
      },
      {
        status: 400
      }
    );
  }

  const session = await getAuthenticatedUser(request.headers).catch(() => null);
  const accountUserHash = session ? hashAnalyticsUserId(session.user.id) : undefined;
  const clientId = getHeader(request.headers, "x-linkdish-client-id") ?? undefined;

  const events = parsed.data.events.map((event) => ({
    ...event,
    ...((event.anonymousId ?? clientId) ? { anonymousId: event.anonymousId ?? clientId } : {}),
    ...(accountUserHash ? { accountUserHash } : {}),
    properties: sanitizeAnalyticsProperties(event.properties)
  }));

  return corsJson(request, {
    accepted: await writeAnalyticsEvents(events)
  });
}
