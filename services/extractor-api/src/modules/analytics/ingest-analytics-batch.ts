import {
  analyticsEventBatchEnvelopeSchema,
  parseAnalyticsEventBatch
} from "../../../../../packages/api-contracts/src/index.js";
import { getAuthenticatedUser } from "../auth/auth-service.js";
import { getHeader, type RequestHeaders } from "../request-identity.js";

import {
  hashAnalyticsUserId,
  normalizeAnalyticsClientId,
  sanitizeAnalyticsProperties
} from "./analytics-privacy.js";
import { writeAnalyticsEvents } from "./analytics-store.js";

import type { AnalyticsEventBatchResponse } from "../../../../../packages/api-contracts/src/index.js";
import type { ZodIssue } from "zod";

export type AnalyticsBatchIngestResult =
  | { kind: "invalid"; message: string; issues: ZodIssue[] }
  | { kind: "accepted"; body: Required<AnalyticsEventBatchResponse> };

export interface AnalyticsBatchIngestLogger {
  warn(message: string, details: Record<string, unknown>): void;
}

const maxLoggedDroppedPaths = 5;

/**
 * POST /analytics/events, shared by the Vercel adapter and the Fastify route.
 *
 * Only the batch envelope can fail the request (400). Events are validated one by one: an event
 * with a name this API does not know yet (a client released before the API), or with bad
 * properties, is dropped and counted, and the rest of the batch is still written. A storage
 * failure never loses or 500s the batch either; it reports accepted: 0.
 */
export const ingestAnalyticsBatch = async (
  payload: unknown,
  headers: RequestHeaders,
  logger: AnalyticsBatchIngestLogger
): Promise<AnalyticsBatchIngestResult> => {
  const envelope = analyticsEventBatchEnvelopeSchema.safeParse(payload);
  const parsed = envelope.success ? parseAnalyticsEventBatch(payload) : null;

  if (!parsed) {
    return {
      kind: "invalid",
      message: "Invalid analytics event batch.",
      issues: envelope.success ? [] : envelope.error.issues
    };
  }

  if (parsed.dropped > 0) {
    logger.warn("Dropped invalid analytics events.", {
      dropped: parsed.dropped,
      paths: parsed.droppedPaths.slice(0, maxLoggedDroppedPaths)
    });
  }

  if (parsed.events.length === 0) {
    return { kind: "accepted", body: { accepted: 0, dropped: parsed.dropped } };
  }

  const session = await getAuthenticatedUser(headers).catch(() => null);
  const accountUserHash = session ? hashAnalyticsUserId(session.user.id) : undefined;
  const clientId = normalizeAnalyticsClientId(getHeader(headers, "x-linkdish-client-id"));
  const events = parsed.events.map((event) => ({
    ...event,
    ...((event.anonymousId ?? clientId) ? { anonymousId: event.anonymousId ?? clientId } : {}),
    ...(accountUserHash ? { accountUserHash } : {}),
    properties: sanitizeAnalyticsProperties(event.properties)
  }));

  const accepted = await writeAnalyticsEvents(events).catch((error: unknown) => {
    logger.warn("Failed to write analytics events.", {
      message: error instanceof Error ? error.message : "Unknown error"
    });
    return 0;
  });

  return { kind: "accepted", body: { accepted, dropped: parsed.dropped } };
};
