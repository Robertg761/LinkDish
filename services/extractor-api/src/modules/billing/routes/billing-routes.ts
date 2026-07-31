import { ZodError } from "zod";

import { extractorApiEnv } from "../../../config/env.js";
import { getAuthenticatedUser } from "../../auth/auth-service.js";
import {
  createWebBillingCheckoutUrl,
  createWebBillingManagementUrl,
  getWebBillingAvailability,
  WebBillingError
} from "../web-billing-links.js";

import type { RequestHeaders } from "../../request-identity.js";
import type { FastifyInstance } from "fastify";

const disabledBody = {
  message: "LinkDish accounts are not enabled."
};

const sendError = (
  reply: { status: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown
) => {
  const statusCode =
    error instanceof WebBillingError ? error.statusCode : error instanceof ZodError ? 400 : 500;

  return reply.status(statusCode).send({
    message: error instanceof Error ? error.message : "Unexpected billing error."
  });
};

const getRequiredSession = async (headers: RequestHeaders) => {
  const session = await getAuthenticatedUser(headers);

  if (!session) {
    throw new WebBillingError("Sign in is required before managing billing.", 401);
  }

  return session;
};

export const registerBillingRoutes = (app: FastifyInstance) => {
  app.get("/billing/config", async (_request, reply) =>
    reply.status(200).send(getWebBillingAvailability())
  );

  app.post("/billing/checkout", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    try {
      const session = await getRequiredSession(request.headers);

      return reply.status(200).send({
        url: createWebBillingCheckoutUrl(request.body, session.user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/billing/portal", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    try {
      const session = await getRequiredSession(request.headers);

      return reply.status(200).send({
        url: await createWebBillingManagementUrl(session.user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
