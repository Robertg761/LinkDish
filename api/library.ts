import { ZodError } from "zod";

import {
  pullLibraryChangesQuerySchema,
  pushLibraryChangesEnvelopeSchema
} from "../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
import {
  pullLibraryChanges,
  pushLibraryChanges
} from "../services/extractor-api/src/modules/library/library-service.js";

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
 * Unclassified failures carry provider internals (Upstash hostnames, connection strings), so the
 * client only learns that the request failed and the detail is logged server-side.
 */
const errorResponse = (request: Request, error: unknown): Response => {
  const status = getClassifiedErrorStatus(error);

  if (status === null) {
    console.error("Unhandled library error.", error);

    return jsonError(request, genericErrorMessage, 500);
  }

  return jsonError(request, error instanceof Error ? error.message : genericErrorMessage, status);
};

const getRequiredSession = async (request: Request) => {
  const session = await getAuthenticatedUser(request.headers);

  if (!session) {
    throw Object.assign(new Error("Sign in is required."), {
      statusCode: 401
    });
  }

  return session;
};

const notEnabled = (request: Request): Response =>
  jsonError(request, "LinkDish cloud sync is not enabled.", 404);

const notFound = (request: Request): Response =>
  jsonError(request, "Library route not found.", 404);

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function GET(request: Request) {
  if (!extractorApiEnv.LIBRARY_SYNC_ENABLED) {
    return notEnabled(request);
  }

  if (getPath(request) !== "changes") {
    return notFound(request);
  }

  try {
    const session = await getRequiredSession(request);
    const query = pullLibraryChangesQuerySchema.parse({
      since: new URL(request.url).searchParams.get("since") ?? undefined
    });
    return corsJson(request, await pullLibraryChanges(session.user.id, query.since), {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(request: Request) {
  if (!extractorApiEnv.LIBRARY_SYNC_ENABLED) {
    return notEnabled(request);
  }

  if (getPath(request) !== "changes") {
    return notFound(request);
  }

  try {
    const session = await getRequiredSession(request);
    const payload = pushLibraryChangesEnvelopeSchema.parse(await readJsonBody(request));

    return corsJson(request, await pushLibraryChanges(session.user.id, payload.changes));
  } catch (error) {
    return errorResponse(request, error);
  }
}
