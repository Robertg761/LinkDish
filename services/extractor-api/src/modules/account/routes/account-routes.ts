import { ZodError } from "zod";

import {
  deleteAccountRequestSchema,
  updateAccountProfileRequestSchema
} from "../../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { getAuthenticatedUser, updateUserProfileById } from "../../auth/auth-service.js";
import { getEffectiveAccountBillingPlanId } from "../../billing/account-billing-plan.js";
import { deleteAccountAndHouseholdAccess } from "../../households/household-service.js";

import type { AccountUser } from "../../../../../../packages/api-contracts/src/index.js";
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
    message: error instanceof Error ? error.message : "Unexpected account error."
  });
};

const getAccountBillingPlanId = async (userId: string): Promise<AccountUser["billingPlan"]> => {
  try {
    return await getEffectiveAccountBillingPlanId(userId);
  } catch (error) {
    console.warn("Failed to resolve account billing plan for account response.", error);
    return undefined;
  }
};

const withBillingPlan = async (user: AccountUser): Promise<AccountUser> => ({
  ...user,
  billingPlan: await getAccountBillingPlanId(user.id)
});

export const registerAccountRoutes = (app: FastifyInstance) => {
  app.patch("/account", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getAuthenticatedUser(request.headers);

      if (!session) {
        return reply.status(401).send({
          message: "Sign in is required."
        });
      }

      const payload = updateAccountProfileRequestSchema.parse(request.body);
      const user = await updateUserProfileById(session.user.id, payload);

      if (!user) {
        return reply.status(404).send({
          message: "LinkDish account not found."
        });
      }

      return reply.status(200).send({
        user: await withBillingPlan(user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/account", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getAuthenticatedUser(request.headers);

      if (!session) {
        return reply.status(401).send({
          message: "Sign in is required."
        });
      }

      const payload = deleteAccountRequestSchema.parse(request.body);
      await deleteAccountAndHouseholdAccess(session.user, payload.confirmEmail);

      return reply.status(200).send({
        status: "deleted"
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
