import { ingestAnalyticsBatch } from "../ingest-analytics-batch.js";

import type { FastifyInstance } from "fastify";

/**
 * The web client flushes on page hide with `navigator.sendBeacon`, posting the JSON batch as
 * `text/plain` so the request stays CORS-simple (no preflight). Fastify's built-in text/plain
 * parser hands that over as a string (already capped by the app's bodyLimit), so it is parsed here,
 * for this route only, the way `request.json()` does in the Vercel adapter. Text that is not JSON
 * becomes null, which the envelope check answers with a 400.
 *
 * Only a text/plain body is parsed: an application/json body Fastify already parsed, and if that
 * gave a string (a double-encoded batch), it is a string, not a batch, as in the Vercel adapter.
 * The media type is matched like Fastify matches its parsers: case-insensitive, parameters dropped.
 */
const readBatchPayload = (body: unknown, contentType: string | undefined): unknown => {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();

  if (typeof body !== "string" || mediaType !== "text/plain") {
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
    const result = await ingestAnalyticsBatch(
      readBatchPayload(request.body, request.headers["content-type"]),
      request.headers,
      {
        warn: (message, details) => request.log.warn(details, message)
      }
    );

    if (result.kind === "invalid") {
      return reply.status(400).send({
        message: result.message,
        issues: result.issues
      });
    }

    return result.body;
  });
};
