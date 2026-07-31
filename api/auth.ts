import { ZodError } from "zod";

import {
  requestLoginCodeRequestSchema,
  verifyLoginCodeRequestSchema
} from "../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import {
  getAuthenticatedUser,
  getBearerToken,
  logoutSession,
  requestLoginCode,
  verifyLoginCode
} from "../services/extractor-api/src/modules/auth/auth-service.js";
import {
  checkLoginCodeRateLimit,
  loginCodeRateLimitExceededMessage
} from "../services/extractor-api/src/modules/auth/login-code-rate-limit.js";
import { getEffectiveAccountBillingPlanId } from "../services/extractor-api/src/modules/billing/account-billing-plan.js";

import type { AccountUser } from "../packages/api-contracts/src/index.js";

export const config = {
  maxDuration: 30
};

const getPath = (request: Request): string =>
  (new URL(request.url).searchParams.get("path") ?? "").replace(/^\/+|\/+$/gu, "");

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
    error instanceof Error ? error.message : "Unexpected auth error.",
    error instanceof ZodError
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500
  );

const disabledResponse = (request: Request): Response =>
  jsonError(request, "LinkDish households are not enabled.", 404);

const authConfigResponse = (request: Request): Response =>
  corsJson(request, {
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

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function GET(request: Request) {
  if (getPath(request) === "config") {
    return authConfigResponse(request);
  }

  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return disabledResponse(request);
  }

  if (getPath(request) !== "session") {
    return jsonError(request, "Auth route not found.", 404);
  }

  try {
    const session = await getAuthenticatedUser(request.headers);

    if (!session) {
      return corsJson(request, {
        authenticated: false
      });
    }

    return corsJson(request, {
      authenticated: true,
      expiresAt: session.expiresAt,
      user: await withBillingPlan(session.user)
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return disabledResponse(request);
  }

  const path = getPath(request);

  try {
    if (path === "login-code") {
      const rateLimit = await checkLoginCodeRateLimit(request.headers);

      if (!rateLimit.allowed) {
        console.warn(
          JSON.stringify({
            ...rateLimit.logContext,
            outcomeStatus: "auth_login_code_rate_limited"
          })
        );

        return corsJson(
          request,
          {
            message: loginCodeRateLimitExceededMessage
          },
          {
            headers: rateLimit.headers,
            status: 429
          }
        );
      }

      const result = await requestLoginCode(
        requestLoginCodeRequestSchema.parse(await readJsonBody(request)).email
      );
      return corsJson(request, {
        status: "sent",
        ...result
      });
    }

    if (path === "verify-code") {
      const payload = verifyLoginCodeRequestSchema.parse(await readJsonBody(request));
      const profile =
        payload.avatarEmoji !== undefined || payload.displayName !== undefined
          ? {
              avatarEmoji: payload.avatarEmoji,
              displayName: payload.displayName
            }
          : undefined;
      const result = await verifyLoginCode(payload.email, payload.code, profile);
      return corsJson(request, {
        status: "authenticated",
        ...result,
        user: await withBillingPlan(result.user)
      });
    }

    if (path === "logout") {
      const token = getBearerToken(request.headers);

      if (token) {
        await logoutSession(token);
      }

      return corsJson(request, {
        status: "logged_out"
      });
    }

    return jsonError(request, "Auth route not found.", 404);
  } catch (error) {
    return errorResponse(request, error);
  }
}
