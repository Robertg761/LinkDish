import { ZodError } from "zod";

import { joinIosWaitlist } from "../services/extractor-api/src/modules/waitlist/ios-waitlist-service.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 30
};

const allowedOrigins = new Set([
  "https://linkdish.ca",
  "https://www.linkdish.ca",
  "https://linkdish.xyz",
  "https://www.linkdish.xyz",
  "http://localhost:8007",
  "http://localhost:8011",
  "http://127.0.0.1:8007",
  "http://127.0.0.1:8011"
]);

const getCorsHeaders = (request: Request): HeadersInit => {
  const origin = request.headers.get("origin");
  const allowOrigin = origin && allowedOrigins.has(origin) ? origin : "https://linkdish.ca";

  return {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": allowOrigin,
    vary: "Origin"
  };
};

const jsonError = (request: Request, message: string, status: number): Response =>
  Response.json(
    {
      message
    },
    {
      headers: getCorsHeaders(request),
      status
    }
  );

const genericErrorMessage = "Something went wrong on our side. Please try again in a moment.";

/* null means the error carried no status of its own, i.e. it is unclassified. */
const getClassifiedErrorStatus = (error: unknown): number | null =>
  error instanceof ZodError
    ? 400
    : typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : null;

/*
 * Unclassified failures carry provider internals (Upstash/Resend hostnames,
 * connection strings), so the client only learns that the request failed and
 * the detail is logged server-side.
 */
const errorResponse = (request: Request, error: unknown): Response => {
  const status = getClassifiedErrorStatus(error);

  if (status === null) {
    console.error("Unhandled waitlist error.", error);

    return jsonError(request, genericErrorMessage, 500);
  }

  return jsonError(request, error instanceof Error ? error.message : genericErrorMessage, status);
};

export function OPTIONS(request: Request) {
  return new Response(null, {
    headers: getCorsHeaders(request),
    status: 204
  });
}

export async function POST(request: Request) {
  try {
    const result = await joinIosWaitlist(
      await request.json(),
      request.headers,
      getVercelRequestIdentity(request)
    );
    return Response.json(result, {
      headers: getCorsHeaders(request),
      status: 200
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
