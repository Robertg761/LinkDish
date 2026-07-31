import { handleRevenueCatWebhook } from "../revenuecat-webhook-service.js";

import type { FastifyInstance, FastifyRequest } from "fastify";

type RawBodyRequest = FastifyRequest & {
  rawBody?: string;
};

const sendError = (
  reply: { status: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown
) => {
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;

  return reply.status(statusCode).send({
    message: error instanceof Error ? error.message : "Unexpected RevenueCat webhook error."
  });
};

export const registerRevenueCatWebhookRoutes = (app: FastifyInstance) => {
  app.post("/webhooks/revenuecat", async (request: RawBodyRequest, reply) => {
    try {
      const rawBody =
        request.rawBody ??
        (typeof request.body === "string" ? request.body : JSON.stringify(request.body));
      const result = await handleRevenueCatWebhook({
        headers: request.headers,
        rawBody
      });

      return reply.status(200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
