import { ZodError } from "zod";

import {
  pullLibraryChangesQuerySchema,
  pushLibraryChangesEnvelopeSchema
} from "../../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { getAuthenticatedUser } from "../../auth/auth-service.js";
import { pullLibraryChanges, pushLibraryChanges } from "../library-service.js";

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
    message: error instanceof Error ? error.message : "Unexpected library error."
  });
};

const getRequiredSession = async (headers: unknown) => {
  const session = await getAuthenticatedUser(headers as Parameters<typeof getAuthenticatedUser>[0]);

  if (!session) {
    throw Object.assign(new Error("Sign in is required."), {
      statusCode: 401
    });
  }

  return session;
};

const libraryDisabled = { message: "LinkDish cloud sync is not enabled." };

export const registerLibraryRoutes = (app: FastifyInstance) => {
  app.get("/library/changes", async (request, reply) => {
    if (!extractorApiEnv.LIBRARY_SYNC_ENABLED) {
      return reply.status(404).send(libraryDisabled);
    }

    try {
      const session = await getRequiredSession(request.headers);
      const query = pullLibraryChangesQuerySchema.parse(request.query ?? {});
      return reply
        .status(200)
        .header("cache-control", "no-store")
        .send(await pullLibraryChanges(session.user.id, query.since));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/library/changes", async (request, reply) => {
    if (!extractorApiEnv.LIBRARY_SYNC_ENABLED) {
      return reply.status(404).send(libraryDisabled);
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = pushLibraryChangesEnvelopeSchema.parse(request.body);
      return reply.status(200).send(await pushLibraryChanges(session.user.id, payload.changes));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
