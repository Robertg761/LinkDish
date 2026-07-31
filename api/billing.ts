import { ZodError } from "zod";

import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
import { handleRevenueCatWebhook } from "../services/extractor-api/src/modules/billing/revenuecat-webhook-service.js";
import {
  createWebBillingCheckoutUrl,
  createWebBillingManagementUrl,
  getWebBillingAvailability,
  WebBillingError
} from "../services/extractor-api/src/modules/billing/web-billing-links.js";

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

const errorResponse = (request: Request, error: unknown): Response =>
  jsonError(
    request,
    error instanceof Error ? error.message : "Unexpected billing error.",
    error instanceof WebBillingError
      ? error.statusCode
      : error instanceof ZodError
        ? 400
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : 500
  );

const getRequiredSession = async (request: Request) => {
  const session = await getAuthenticatedUser(request.headers);

  if (!session) {
    throw new WebBillingError("Sign in is required before managing billing.", 401);
  }

  return session;
};

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export function GET(request: Request) {
  if (getPath(request) !== "config") {
    return jsonError(request, "Billing route not found.", 404);
  }

  return corsJson(request, getWebBillingAvailability());
}

export async function POST(request: Request) {
  const path = getPath(request);

  if (path === "revenuecat-webhook") {
    try {
      return corsJson(
        request,
        await handleRevenueCatWebhook({
          headers: request.headers,
          rawBody: await request.text()
        })
      );
    } catch (error) {
      return errorResponse(request, error);
    }
  }

  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish accounts are not enabled.", 404);
  }

  try {
    const session = await getRequiredSession(request);

    if (path === "checkout") {
      return corsJson(request, {
        url: createWebBillingCheckoutUrl(await request.json(), session.user)
      });
    }

    if (path === "portal") {
      return corsJson(request, {
        url: await createWebBillingManagementUrl(session.user)
      });
    }

    return jsonError(request, "Billing route not found.", 404);
  } catch (error) {
    return errorResponse(request, error);
  }
}
