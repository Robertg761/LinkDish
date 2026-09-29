import { ZodError } from "zod";

import { billingUsageResponseSchema } from "../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
import { readBillingUsage } from "../services/extractor-api/src/modules/billing/enforce-billing.js";
import { handleRevenueCatWebhook } from "../services/extractor-api/src/modules/billing/revenuecat-webhook-service.js";
import {
  createWebBillingCheckoutUrl,
  createWebBillingManagementUrl,
  getWebBillingAvailability,
  WebBillingError
} from "../services/extractor-api/src/modules/billing/web-billing-links.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

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

const genericErrorMessage = "Something went wrong on our side. Please try again in a moment.";

/* null means the error carried no status of its own, i.e. it is unclassified. */
const getClassifiedErrorStatus = (error: unknown): number | null =>
  error instanceof WebBillingError
    ? error.statusCode
    : error instanceof ZodError
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;

/*
 * Unclassified failures carry provider internals (Upstash/Postgres hostnames,
 * connection strings), so the client only learns that the request failed and
 * the detail is logged server-side.
 */
const errorResponse = (request: Request, error: unknown): Response => {
  const status = getClassifiedErrorStatus(error);

  if (status === null) {
    console.error("Unhandled billing error.", error);

    return jsonError(request, genericErrorMessage, 500);
  }

  return jsonError(request, error instanceof Error ? error.message : genericErrorMessage, status);
};

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

const billingUsageRateLimitPolicy = {
  max: 60,
  scope: "billing-usage",
  windowMs: 60 * 1_000
} as const;

/*
 * GET /billing/usage: the caller's import allowance, resolved the way /extract resolves it
 * (install id or signed-in account, plan, household) but without counting anything.
 */
const getBillingUsage = async (request: Request): Promise<Response> => {
  const identity = getVercelRequestIdentity(request);

  try {
    const rateLimit = await checkPublicEndpointRateLimit(
      request.headers,
      billingUsageRateLimitPolicy,
      identity
    );

    if (!rateLimit.allowed) {
      return corsJson(
        request,
        { message: "Too many billing usage requests." },
        { headers: rateLimit.headers, status: 429 }
      );
    }

    const usage = billingUsageResponseSchema.parse(
      await readBillingUsage(request.headers, identity)
    );

    return corsJson(request, usage, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return jsonError(request, "LinkDish could not check your allowance right now.", 503);
    }

    return errorResponse(request, error);
  }
};

export async function GET(request: Request): Promise<Response> {
  const path = getPath(request);

  if (path === "config") {
    return corsJson(request, getWebBillingAvailability());
  }

  if (path === "usage") {
    return getBillingUsage(request);
  }

  return jsonError(request, "Billing route not found.", 404);
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
