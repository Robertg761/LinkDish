import { analyticsEventBatchRequestSchema } from "../../../../../../packages/api-contracts/src/index.js";
import { getAuthenticatedUser } from "../../auth/auth-service.js";
import { getHeader } from "../../request-identity.js";
import {
  hashAnalyticsUserId,
  normalizeAnalyticsClientId,
  sanitizeAnalyticsProperties
} from "../analytics-privacy.js";
import { writeAnalyticsEvents } from "../analytics-store.js";

import type { FastifyInstance } from "fastify";

export const registerAnalyticsRoutes = (app: FastifyInstance) => {
  app.post("/analytics/events", async (request, reply) => {
    const parsed = analyticsEventBatchRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        message: "Invalid analytics event batch.",
        issues: parsed.error.issues
      });
    }

    const session = await getAuthenticatedUser(request.headers).catch(() => null);
    const accountUserHash = session ? hashAnalyticsUserId(session.user.id) : undefined;
    const clientId = normalizeAnalyticsClientId(
      getHeader(request.headers, "x-linkdish-client-id")
    );

    const events = parsed.data.events.map((event) => ({
      ...event,
      ...((event.anonymousId ?? clientId) ? { anonymousId: event.anonymousId ?? clientId } : {}),
      ...(accountUserHash ? { accountUserHash } : {}),
      properties: sanitizeAnalyticsProperties(event.properties)
    }));

    /* A storage failure must not lose (or 500) the whole batch. */
    const accepted = await writeAnalyticsEvents(events).catch((error: unknown) => {
      request.log.warn({ err: error }, "Failed to write analytics events.");
      return 0;
    });

    return {
      accepted
    };
  });
};
