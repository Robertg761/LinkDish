import { ZodError } from "zod";

import {
  requestLoginCodeRequestSchema,
  verifyLoginCodeRequestSchema
} from "../../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { getEffectiveAccountBillingPlanId } from "../../billing/account-billing-plan.js";
import {
  getAuthenticatedUser,
  getBearerToken,
  logoutSession,
  requestLoginCode,
  verifyLoginCode
} from "../auth-service.js";
import {
  checkLoginCodeRateLimit,
  loginCodeRateLimitExceededMessage
} from "../login-code-rate-limit.js";

import type { AccountUser } from "../../../../../../packages/api-contracts/src/index.js";
import type { FastifyInstance } from "fastify";

const disabledBody = {
  message: "LinkDish households are not enabled."
};

const getAuthConfig = () => ({
  authMode: extractorApiEnv.AUTH_MODE,
  clerkEnabled: extractorApiEnv.AUTH_MODE !== "legacy_email_code",
  emailCodeEnabled: extractorApiEnv.AUTH_MODE !== "clerk_primary"
});

const getAccountBillingPlanId = async (userId: string): Promise<AccountUser["billingPlan"]> => {
  try {
    return await getEffectiveAccountBillingPlanId(userId);
  } catch (error) {
    console.warn("Failed to resolve account billing plan for auth response.", error);
    return undefined;
  }
};

const withBillingPlan = async (user: AccountUser): Promise<AccountUser> => ({
  ...user,
  billingPlan: await getAccountBillingPlanId(user.id)
});

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
    message: error instanceof Error ? error.message : "Unexpected auth error."
  });
};

export const registerAuthRoutes = (app: FastifyInstance) => {
  app.get("/auth/config", async (_request, reply) => reply.status(200).send(getAuthConfig()));

  app.post("/auth/login-code", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    try {
      const rateLimit = await checkLoginCodeRateLimit(request.headers, {
        remoteAddress: request.ip
      });

      if (!rateLimit.allowed) {
        console.warn(
          JSON.stringify({
            ...rateLimit.logContext,
            outcomeStatus: "auth_login_code_rate_limited"
          })
        );

        return reply.headers(rateLimit.headers).status(429).send({
          message: loginCodeRateLimitExceededMessage
        });
      }

      const result = await requestLoginCode(
        requestLoginCodeRequestSchema.parse(request.body).email
      );
      return reply.status(200).send({
        status: "sent",
        ...result
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/auth/verify-code", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    try {
      const payload = verifyLoginCodeRequestSchema.parse(request.body);
      const profile =
        payload.avatarEmoji !== undefined || payload.displayName !== undefined
          ? {
              avatarEmoji: payload.avatarEmoji,
              displayName: payload.displayName
            }
          : undefined;
      const result = await verifyLoginCode(payload.email, payload.code, profile);
      return reply.status(200).send({
        status: "authenticated",
        ...result,
        user: await withBillingPlan(result.user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/auth/session", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    try {
      const session = await getAuthenticatedUser(request.headers);

      if (!session) {
        return reply.status(200).send({
          authenticated: false
        });
      }

      return reply.status(200).send({
        authenticated: true,
        expiresAt: session.expiresAt,
        user: await withBillingPlan(session.user)
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
      return reply.status(404).send(disabledBody);
    }

    const token = getBearerToken(request.headers);

    if (token) {
      await logoutSession(token);
    }

    return reply.status(200).send({
      status: "logged_out"
    });
  });
};
