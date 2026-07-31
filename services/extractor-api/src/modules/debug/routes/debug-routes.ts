import { createDebugFullHouseholdSimulation } from "../../households/household-service.js";

import type { FastifyInstance } from "fastify";

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
    message: error instanceof Error ? error.message : "Unexpected debug simulator error."
  });
};

export const registerDebugRoutes = (app: FastifyInstance) => {
  app.post("/debug/household/full", async (_request, reply) => {
    try {
      return reply.status(200).send(await createDebugFullHouseholdSimulation());
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
