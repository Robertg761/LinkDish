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
} from "../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
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
} from "../services/extractor-api/src/modules/households/household-service.js";

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
    error instanceof Error ? error.message : "Unexpected household error.",
    error instanceof ZodError
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
    throw Object.assign(new Error("Sign in is required."), {
      statusCode: 401
    });
  }

  return session;
};

export function OPTIONS(request: Request) {
  const response = corsPreflight(request);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-methods", "DELETE, GET, OPTIONS, PATCH, POST, PUT");

  return new Response(null, {
    headers,
    status: response.status
  });
}

export async function GET(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  const path = getPath(request);

  if (path && path !== "recipes" && path !== "shopping") {
    return jsonError(request, "Household route not found.", 404);
  }

  try {
    const session = await getRequiredSession(request);
    if (path === "recipes") {
      return corsJson(request, await getSharedRecipesForUser(session.user));
    }

    if (path === "shopping") {
      return corsJson(request, await getHouseholdShoppingListForUser(session.user));
    }

    return corsJson(request, await getHouseholdSummaryForUser(session.user.id));
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function POST(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  const path = getPath(request);

  try {
    const session = await getRequiredSession(request);

    if (!path) {
      return corsJson(request, {
        household: await createHouseholdForOwner(session.user)
      });
    }

    if (path === "invites") {
      const payload = createInviteRequestSchema.parse(await request.json());
      return corsJson(request, await createHouseholdInvite(session.user, payload.email));
    }

    if (path === "invites/accept") {
      const payload = acceptInviteRequestSchema.parse(await request.json());
      return corsJson(request, {
        household: await acceptHouseholdInvite(session.user, payload.inviteCode)
      });
    }

    if (path === "members/remove") {
      const payload = removeHouseholdMemberRequestSchema.parse(await request.json());
      return corsJson(request, {
        household: await removeHouseholdMember(session.user, payload.userId)
      });
    }

    if (path === "leave") {
      return corsJson(request, await leaveHousehold(session.user));
    }

    if (path === "recipes") {
      const payload = upsertSharedRecipeRequestSchema.parse(await request.json());
      return corsJson(request, {
        recipe: await upsertSharedRecipeForUser(session.user, payload)
      });
    }

    return jsonError(request, "Household route not found.", 404);
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function PUT(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  const path = getPath(request);

  if (path !== "shopping/items") {
    return jsonError(request, "Household route not found.", 404);
  }

  try {
    const session = await getRequiredSession(request);
    const payload = upsertShoppingItemsRequestSchema.parse(await request.json());
    return corsJson(request, await upsertShoppingItemsForUser(session.user, payload));
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function PATCH(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  const path = getPath(request);
  const match = /^recipes\/([^/]+)$/u.exec(path);

  if (!match?.[1]) {
    return jsonError(request, "Household route not found.", 404);
  }

  try {
    const session = await getRequiredSession(request);
    const payload = updateSharedRecipeRequestSchema.parse(await request.json());
    return corsJson(request, {
      recipe: await updateSharedRecipeForUser(session.user, decodeURIComponent(match[1]), payload)
    });
  } catch (error) {
    return errorResponse(request, error);
  }
}

export async function DELETE(request: Request) {
  if (!extractorApiEnv.HOUSEHOLDS_ENABLED) {
    return jsonError(request, "LinkDish households are not enabled.", 404);
  }

  const path = getPath(request);
  const inviteMatch = /^invites\/([^/]+)$/u.exec(path);
  const recipeMatch = /^recipes\/([^/]+)$/u.exec(path);

  if (path === "shopping/items") {
    try {
      const session = await getRequiredSession(request);
      const payload = deleteShoppingItemsRequestSchema.parse(await request.json());
      return corsJson(request, await deleteShoppingItemsForUser(session.user, payload));
    } catch (error) {
      return errorResponse(request, error);
    }
  }

  if (!inviteMatch?.[1] && !recipeMatch?.[1]) {
    return jsonError(request, "Household route not found.", 404);
  }

  try {
    const session = await getRequiredSession(request);

    if (inviteMatch?.[1]) {
      const payload = cancelInviteRequestSchema.parse({
        inviteId: decodeURIComponent(inviteMatch[1])
      });

      return corsJson(request, await cancelHouseholdInvite(session.user, payload.inviteId));
    }

    return corsJson(
      request,
      await deleteSharedRecipeForUser(session.user, decodeURIComponent(recipeMatch?.[1] ?? ""))
    );
  } catch (error) {
    return errorResponse(request, error);
  }
}
