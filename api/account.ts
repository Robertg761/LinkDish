import { ZodError } from "zod";

import {
  deleteAccountRequestSchema,
  updateAccountProfileRequestSchema
} from "../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import {
  getAuthenticatedUser,
  updateUserProfileById
} from "../services/extractor-api/src/modules/auth/auth-service.js";
import { getEffectiveAccountBillingPlanId } from "../services/extractor-api/src/modules/billing/account-billing-plan.js";
import { deleteAccountAndHouseholdAccess } from "../services/extractor-api/src/modules/households/household-service.js";

import type { AccountUser } from "../packages/api-contracts/src/index.js";

export const config = {
  maxDuration: 30
};

const jsonError = (request: Request, message: string, status: number): Response =>
  corsJson(
    request,
    {
      message
    },
    {
      status
    }
  );

class JsonBodyError extends Error {
  public readonly statusCode = 400;

  public constructor() {
    super("Request body must be valid JSON.");
    this.name = "JsonBodyError";
  }
}

const readJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new JsonBodyError();
    }

    throw error;
  }
};

const errorResponse = (request: Request, error: unknown): Response =>
  jsonError(
    request,
    error instanceof Error ? error.message : "Unexpected account error.",
    error instanceof ZodError
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500
  );

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

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function PATCH(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  try {
    const session = await getAuthenticatedUser(request.headers);

    if (!session) {
      return jsonError(request, "Sign in is required.", 401);
    }

    const payload = updateAccountProfileRequestSchema.parse(await readJsonBody(request));
    const user = await updateUserProfileById(session.user.id, payload);

    if (!user) {
      return jsonError(request, "LinkDish account not found.", 404);
    }

    return corsJson(request, {
      user: await withBillingPlan(user)
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function DELETE(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  try {
    const session = await getAuthenticatedUser(request.headers);

    if (!session) {
      return jsonError(request, "Sign in is required.", 401);
    }

    const payload = deleteAccountRequestSchema.parse(await readJsonBody(request));
    await deleteAccountAndHouseholdAccess(session.user, payload.confirmEmail);

    return corsJson(request, {
      status: "deleted"
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
