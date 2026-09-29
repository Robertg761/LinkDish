import { getAuthenticatedUser } from "../auth/auth-service.js";
import { getHeader, isLiveCanaryRequest } from "../request-identity.js";

import { hashAnalyticsUserId } from "./analytics-privacy.js";
import { writeExtractionAnalyticsEvent } from "./analytics-store.js";

import type { AnalyticsPlatform } from "../../../../../packages/api-contracts/src/index.js";
import type { AdminExtractionEventInput } from "../admin/metrics.js";
import type { RequestHeaders } from "../request-identity.js";

const getPlatform = (headers: RequestHeaders): AnalyticsPlatform => {
  const rawPlatform = getHeader(headers, "x-linkdish-platform");

  if (
    rawPlatform === "web_app" ||
    rawPlatform === "android_app" ||
    rawPlatform === "marketing_site"
  ) {
    return rawPlatform;
  }

  return "backend";
};

export const recordDurableExtractionAnalyticsEvent = async (
  headers: RequestHeaders,
  event: AdminExtractionEventInput,
  context: { correlationId?: string } = {}
): Promise<void> => {
  if (isLiveCanaryRequest(headers)) {
    return;
  }

  /*
   * Billing already resolved the signed-in account for most requests; reuse it
   * instead of authenticating the request a second time (1-4 store reads and
   * possibly a Clerk verification).
   */
  const accountUserId =
    event.billing.accountUserId ??
    (await getAuthenticatedUser(headers).catch(() => null))?.user.id ??
    null;

  const anonymousId = getHeader(headers, "x-linkdish-client-id") ?? undefined;
  const sessionId = getHeader(headers, "x-linkdish-session-id") ?? undefined;
  const appVersion = getHeader(headers, "x-linkdish-app-version") ?? undefined;
  const buildNumber = getHeader(headers, "x-linkdish-build-number") ?? undefined;
  const accountUserHash = accountUserId ? hashAnalyticsUserId(accountUserId) : undefined;

  await writeExtractionAnalyticsEvent({
    extraction: event.extraction,
    billingPlan: event.billing.billingPlan,
    latencyMs: event.latencyMs,
    meteringMode: event.billing.meteringMode,
    platform: getPlatform(headers),
    occurredAt: new Date().toISOString(),
    ...(anonymousId ? { anonymousId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(accountUserHash ? { accountUserHash } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(buildNumber ? { buildNumber } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    ...(event.blockedReason ? { blockedReason: event.blockedReason } : {})
  });
};
