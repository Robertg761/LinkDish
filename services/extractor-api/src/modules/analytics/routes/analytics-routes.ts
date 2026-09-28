import { ingestAnalyticsBatch } from "../ingest-analytics-batch.js";

import type { FastifyInstance } from "fastify";

/**
 * The web client flushes on page hide with `navigator.sendBeacon`, posting the JSON batch as
 * `text/plain` so the request stays CORS-simple (no preflight). Fastify's built-in text/plain
 * parser hands that over as a string (already capped by the app's bodyLimit), so it is parsed here,
 * for this route only, the way `request.json()` does in the Vercel adapter. Text that is not JSON
 * becomes null, which the envelope check answers with a 400.
 */
const readBatchPayload = (body: unknown): unknown => {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
};

export const registerAnalyticsRoutes = (app: FastifyInstance) => {
  app.post("/analytics/events", async (request, reply) => {
    const result = await ingestAnalyticsBatch(readBatchPayload(request.body), request.headers, {
      warn: (message, details) => request.log.warn(details, message)
    });

    if (result.kind === "invalid") {
      return reply.status(400).send({
        message: result.message,
        issues: result.issues
      });
    }

    return result.body;
  });
};
