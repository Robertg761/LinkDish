import { extractRecipeAnyRequestSchema } from "../../../../../../packages/api-contracts/src/index.js";
import { runExtractRequestPipeline } from "../services/extract-request-pipeline.js";

import type { ExtractorRuntime } from "../types.js";
import type { FastifyInstance } from "fastify";

export const registerExtractRoute = (app: FastifyInstance, runtime?: ExtractorRuntime) => {
  app.post("/extract", async (request, reply) => {
    const startedAt = Date.now();

    /*
     * Only the request itself is the client's fault. A ZodError from inside the extraction
     * (an extracted value failing the response contract) is a server error below.
     */
    const parsedPayload = extractRecipeAnyRequestSchema.safeParse(request.body);

    if (!parsedPayload.success) {
      return reply.status(400).send({
        message: "Invalid extract request.",
        issues: parsedPayload.error.issues
      });
    }

    const payload = parsedPayload.data;

    try {
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
      request.log.error(error);

      return reply.status(500).send({
        message: "Unexpected extractor error."
      });
    }
  });
};
