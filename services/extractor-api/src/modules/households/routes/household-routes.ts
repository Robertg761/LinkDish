import { ZodError } from "zod";

import {
  acceptInviteRequestSchema,
  cancelInviteRequestSchema,
  createInviteRequestSchema,
  deleteShoppingItemsRequestSchema,
  removeHouseholdMemberRequestSchema,
  upsertShoppingItemsRequestSchema,
  updateSharedRecipeRequestSchema,
  upsertSharedRecipeRequestSchema
} from "../../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { getAuthenticatedUser } from "../../auth/auth-service.js";
import {
  acceptHouseholdInvite,
  cancelHouseholdInvite,
  createHouseholdForOwner,
  createHouseholdInvite,
  deleteShoppingItemsForUser,
  deleteSharedRecipeForUser,
  getHouseholdShoppingListForUser,
  getSharedRecipesForUser,
  getHouseholdSummaryForUser,
  leaveHousehold,
  removeHouseholdMember,
  upsertShoppingItemsForUser,
  updateSharedRecipeForUser,
  upsertSharedRecipeForUser
} from "../household-service.js";

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
    message: error instanceof Error ? error.message : "Unexpected household error."
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

export const registerHouseholdRoutes = (app: FastifyInstance) => {
  app.get("/household", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      return reply.status(200).send(await getHouseholdSummaryForUser(session.user.id));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      return reply.status(200).send({
        household: await createHouseholdForOwner(session.user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household/invites", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = createInviteRequestSchema.parse(request.body);
      return reply.status(200).send(await createHouseholdInvite(session.user, payload.email));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household/invites/accept", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = acceptInviteRequestSchema.parse(request.body);
      return reply.status(200).send({
        household: await acceptHouseholdInvite(session.user, payload.inviteCode)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/household/invites/:inviteId", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const { inviteId = "" } = request.params as { inviteId?: string };
      const payload = cancelInviteRequestSchema.parse({ inviteId });
      return reply.status(200).send(await cancelHouseholdInvite(session.user, payload.inviteId));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household/members/remove", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = removeHouseholdMemberRequestSchema.parse(request.body);
      return reply.status(200).send({
        household: await removeHouseholdMember(session.user, payload.userId)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household/leave", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      return reply.status(200).send(await leaveHousehold(session.user));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/household/recipes", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      return reply.status(200).send(await getSharedRecipesForUser(session.user));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/household/shopping", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      return reply.status(200).send(await getHouseholdShoppingListForUser(session.user));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put("/household/shopping/items", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = upsertShoppingItemsRequestSchema.parse(request.body);
      return reply.status(200).send(await upsertShoppingItemsForUser(session.user, payload));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/household/shopping/items", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = deleteShoppingItemsRequestSchema.parse(request.body);
      return reply.status(200).send(await deleteShoppingItemsForUser(session.user, payload));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/household/recipes", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const payload = upsertSharedRecipeRequestSchema.parse(request.body);
      return reply.status(200).send({
        recipe: await upsertSharedRecipeForUser(session.user, payload)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch("/household/recipes/:recipeId", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const { recipeId = "" } = request.params as { recipeId?: string };
      const payload = updateSharedRecipeRequestSchema.parse(request.body);
      return reply.status(200).send({
        recipe: await updateSharedRecipeForUser(session.user, recipeId, payload)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete("/household/recipes/:recipeId", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send({
        message: "LinkDish households are not enabled."
      });
    }

    try {
      const session = await getRequiredSession(request.headers);
      const { recipeId = "" } = request.params as { recipeId?: string };
      return reply.status(200).send(await deleteSharedRecipeForUser(session.user, recipeId));
    } catch (error) {
      return sendError(reply, error);
    }
  });
};
