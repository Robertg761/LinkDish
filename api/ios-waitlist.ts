import { ZodError } from "zod";

import { joinIosWaitlist } from "../services/extractor-api/src/modules/waitlist/ios-waitlist-service.js";

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

const errorResponse = (request: Request, error: unknown): Response =>
  jsonError(
    request,
    error instanceof Error ? error.message : "Unexpected waitlist error.",
    error instanceof ZodError
      ? 400
      : typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500
  );

export function OPTIONS(request: Request) {
  return new Response(null, {
    headers: getCorsHeaders(request),
    status: 204
  });
}

export async function POST(request: Request) {
  try {
    const result = await joinIosWaitlist(await request.json(), request.headers);
    return Response.json(result, {
      headers: getCorsHeaders(request),
      status: 200
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}
