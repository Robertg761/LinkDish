import { ZodError } from "zod";

import { extractRecipeRequestSchema } from "../../../../../../packages/api-contracts/src/index.js";
import { recordAdminExtractionEvent } from "../../admin/metrics.js";
import { recordDurableExtractionAnalyticsEvent } from "../../analytics/extraction-analytics.js";
import { authorizeExtractionRequest } from "../../billing/enforce-billing.js";
import { extractRecipe } from "../services/extract-recipe.js";

import type { ExtractorRuntime } from "../types.js";
import type { FastifyInstance } from "fastify";

export const registerExtractRoute = (app: FastifyInstance, runtime?: ExtractorRuntime) => {
  app.post("/extract", async (request, reply) => {
    const startedAt = Date.now();

    try {
      const payload = extractRecipeRequestSchema.parse(request.body);
      const billingAuthorization = await authorizeExtractionRequest(
        request.headers,
        payload.attempt,
        {
          remoteAddress: request.ip
        }
      );

      if (!billingAuthorization.allowed) {
        const latencyMs = Date.now() - startedAt;

        const analyticsEvent = {
          extraction: null,
          billing: billingAuthorization.logContext,
          latencyMs,
          blockedReason:
            billingAuthorization.response?.status === "failure"
              ? billingAuthorization.response.reason
              : "billing_denied"
        };

        recordAdminExtractionEvent(analyticsEvent);
        await recordDurableExtractionAnalyticsEvent(request.headers, analyticsEvent, {
          ...(payload.correlationId ? { correlationId: payload.correlationId } : {})
        }).catch((error) => {
          request.log.warn({ error }, "Failed to record durable extraction analytics.");
        });

        request.log.warn({
          ...billingAuthorization.logContext,
          latencyMs
        });

        return reply.status(200).send(billingAuthorization.response);
      }

      const { response, logContext } = await extractRecipe(payload, runtime);
      const billingLogContext = await billingAuthorization.commitUsage(response);
      const latencyMs = Date.now() - startedAt;

      const analyticsEvent = {
        extraction: logContext,
        billing: billingLogContext,
        latencyMs
      };

      recordAdminExtractionEvent(analyticsEvent);
      await recordDurableExtractionAnalyticsEvent(request.headers, analyticsEvent, {
        ...(payload.correlationId ? { correlationId: payload.correlationId } : {})
      }).catch((error) => {
        request.log.warn({ error }, "Failed to record durable extraction analytics.");
      });

      request.log.info({
        ...billingLogContext,
        ...logContext,
        latencyMs
      });

      return reply.status(200).send(response);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          message: "Invalid extract request.",
          issues: error.issues
        });
      }

      request.log.error(error);

      return reply.status(500).send({
        message: "Unexpected extractor error."
      });
    }
  });
};
