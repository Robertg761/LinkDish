import { ZodError } from "zod";

import { extractRecipeRequestSchema } from "../../../../../../packages/api-contracts/src/index.js";
import { runExtractRequestPipeline } from "../services/extract-request-pipeline.js";

import type { ExtractorRuntime } from "../types.js";
import type { FastifyInstance } from "fastify";

export const registerExtractRoute = (app: FastifyInstance, runtime?: ExtractorRuntime) => {
  app.post("/extract", async (request, reply) => {
    const startedAt = Date.now();

    try {
      const payload = extractRecipeRequestSchema.parse(request.body);
      /*
       * Same pipeline as the Vercel adapter. The long-lived server has no
       * waitUntil, so post-response work (analytics, cache writes) simply
       * continues in the background; each task handles its own errors.
       */
      const { response, headers } = await runExtractRequestPipeline({
        payload,
        headers: request.headers,
        identity: {
          remoteAddress: request.ip
        },
        startedAt,
        ...(runtime ? { runtime } : {}),
        schedule: (task) => {
          void task;
        },
        logger: {
          info: (entry) => request.log.info(entry),
          warn: (entry) => request.log.warn(entry)
        }
      });

      return reply.status(200).headers(headers).send(response);
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
