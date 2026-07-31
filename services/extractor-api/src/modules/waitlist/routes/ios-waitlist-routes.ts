import { ZodError } from "zod";

import { joinIosWaitlist } from "../ios-waitlist-service.js";

import type { FastifyInstance } from "fastify";

const sendError = (
  reply: { status: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown
) => {
  const statusCode =
    error instanceof ZodError
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;

  return reply.status(statusCode).send({
    message: error instanceof Error ? error.message : "Unexpected waitlist error."
  });
};

export const registerIosWaitlistRoutes = (app: FastifyInstance) => {
  app.post("/ios-waitlist", async (request, reply) => {
    try {
      return reply.status(200).send(await joinIosWaitlist(request.body, request.headers));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
