import { ingestAnalyticsBatch } from "../ingest-analytics-batch.js";

import type { FastifyInstance } from "fastify";

export const registerAnalyticsRoutes = (app: FastifyInstance) => {
  app.post("/analytics/events", async (request, reply) => {
    const result = await ingestAnalyticsBatch(request.body, request.headers, {
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
