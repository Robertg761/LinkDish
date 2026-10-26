import { z } from "zod";

import {
  authorizeAdminAccess,
  isAdminAuthConfigured,
  type AdminRequestContext
} from "../services/extractor-api/src/modules/admin/admin-access.js";
import {
  grantAdminBillingPlan,
  lookupAdminUserAccount,
  resetAdminModelSettings,
  updateAdminModelSettings
} from "../services/extractor-api/src/modules/admin/admin-actions.js";
import { withAdminSecurityHeaders } from "../services/extractor-api/src/modules/admin/admin-auth.js";
import {
  AdminBillingGrantError,
  adminBillingGrantRequestSchema
} from "../services/extractor-api/src/modules/admin/billing-grants.js";
import { adminDashboardHtml } from "../services/extractor-api/src/modules/admin/dashboard-assets.js";
import { getAdminDashboardSnapshot } from "../services/extractor-api/src/modules/admin/dashboard-snapshot.js";
import { parseAdminEnvironmentName } from "../services/extractor-api/src/modules/admin/environment-profiles.js";
import {
  AdminModelSettingsValidationError,
  isManagedFallbackExtractor
} from "../services/extractor-api/src/modules/admin/model-control.js";
import { AdminModelSettingsStoreUnavailableError } from "../services/extractor-api/src/modules/admin/model-settings-store.js";
import {
  AdminUserAccountError,
  adminUserLookupQuerySchema,
  getAdminUserAccountDetails
} from "../services/extractor-api/src/modules/admin/user-accounts.js";
import { getSharedExtractorRuntime } from "../services/extractor-api/src/modules/extract/services/runtime.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 60
};

const modelUpdateSchema = z.object({
  provider: z.enum(["gemini", "openai", "none"]).optional(),
  model: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value === "" ? undefined : value))
});

const getAdminPath = (url: URL): string =>
  (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/gu, "");

const authorizeAdminRequest = async (request: Request): Promise<AdminRequestContext | Response> => {
  const url = new URL(request.url);
  const access = await authorizeAdminAccess({
    adapter: "vercel",
    headers: request.headers,
    ip: getVercelRequestIdentity(request).remoteAddress ?? "unknown",
    method: request.method,
    path: `/admin/${getAdminPath(url)}`.replace(/\/$/u, "")
  });

  if (!access.ok) {
    return Response.json(
      {
        message: access.message
      },
      {
        headers: access.headers,
        status: access.status
      }
    );
  }

  return { actor: access.actor, ip: access.ip };
};

const jsonError = (message: string, status: number, detail?: string): Response =>
  Response.json(
    {
      message,
      ...(detail ? { detail } : {})
    },
    {
      status
    }
  );

const handleGet = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const admin = await authorizeAdminRequest(request);

  if (admin instanceof Response) {
    return admin;
  }

  const path = getAdminPath(url);

  if (!path) {
    return new Response(adminDashboardHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    });
  }

  if (path === "api/dashboard") {
    return Response.json(
      await getAdminDashboardSnapshot(
        getSharedExtractorRuntime(),
        parseAdminEnvironmentName(url.searchParams.get("environment")) ?? "production"
      )
    );
  }

  if (path === "api/users") {
    const parsedQuery = adminUserLookupQuerySchema.safeParse({
      email: url.searchParams.get("email")
    });

    if (!parsedQuery.success) {
      return Response.json(
        {
          message: "Invalid user lookup.",
          issues: parsedQuery.error.issues
        },
        {
          status: 400
        }
      );
    }

    try {
      return Response.json(await lookupAdminUserAccount(admin, parsedQuery.data));
    } catch (error) {
      if (error instanceof AdminUserAccountError) {
        return jsonError(error.message, error.statusCode);
      }

      throw error;
    }
  }

  return jsonError("Admin dashboard route not found.", 404);
};

export async function GET(request: Request) {
  return withAdminSecurityHeaders(await handleGet(request));
}

const handlePost = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const admin = await authorizeAdminRequest(request);

  if (admin instanceof Response) {
    return admin;
  }

  if (getAdminPath(url) !== "api/billing/grants") {
    return jsonError("Admin dashboard route not found.", 404);
  }

  if (!isAdminAuthConfigured()) {
    return jsonError("Billing grants require ADMIN_DASHBOARD_TOKENS.", 403);
  }

  const parsedBody = adminBillingGrantRequestSchema.safeParse(await request.json());

  if (!parsedBody.success) {
    return Response.json(
      {
        message: "Invalid billing grant request.",
        issues: parsedBody.error.issues
      },
      {
        status: 400
      }
    );
  }

  try {
    const grant = await grantAdminBillingPlan(admin, parsedBody.data);

    return Response.json({
      ...grant,
      account: parsedBody.data.dryRun
        ? null
        : await getAdminUserAccountDetails({ email: parsedBody.data.email })
    });
  } catch (error) {
    if (error instanceof AdminBillingGrantError) {
      return Response.json(
        {
          detail: error.detail,
          message: error.message
        },
        {
          status: error.statusCode
        }
      );
    }

    throw error;
  }
};

export async function POST(request: Request) {
  return withAdminSecurityHeaders(await handlePost(request));
}

const handlePut = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const admin = await authorizeAdminRequest(request);

  if (admin instanceof Response) {
    return admin;
  }

  if (getAdminPath(url) !== "api/llm") {
    return jsonError("Admin dashboard route not found.", 404);
  }

  const runtime = getSharedExtractorRuntime();

  if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
    return jsonError("This runtime does not support admin model changes.", 409);
  }

  const parsedBody = modelUpdateSchema.safeParse(await request.json());

  if (!parsedBody.success) {
    return Response.json(
      {
        message: "Invalid model update.",
        issues: parsedBody.error.issues
      },
      {
        status: 400
      }
    );
  }

  try {
    const llm = await updateAdminModelSettings(admin, runtime.fallbackExtractor, parsedBody.data);

    return Response.json({
      llm,
      snapshot: await getAdminDashboardSnapshot(runtime)
    });
  } catch (error) {
    if (error instanceof AdminModelSettingsStoreUnavailableError) {
      return jsonError("Could not persist model settings.", 503, error.message);
    }

    if (error instanceof AdminModelSettingsValidationError) {
      return jsonError("Invalid model settings.", 400, error.message);
    }

    throw error;
  }
};

export async function PUT(request: Request) {
  return withAdminSecurityHeaders(await handlePut(request));
}

const handleDelete = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const admin = await authorizeAdminRequest(request);

  if (admin instanceof Response) {
    return admin;
  }

  if (getAdminPath(url) !== "api/llm") {
    return jsonError("Admin dashboard route not found.", 404);
  }

  const runtime = getSharedExtractorRuntime();

  if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
    return jsonError("This runtime does not support admin model changes.", 409);
  }

  try {
    const llm = await resetAdminModelSettings(admin, runtime.fallbackExtractor);

    return Response.json({
      llm,
      snapshot: await getAdminDashboardSnapshot(runtime)
    });
  } catch (error) {
    if (error instanceof AdminModelSettingsStoreUnavailableError) {
      return jsonError("Could not reset persisted model settings.", 503, error.message);
    }

    throw error;
  }
};

export async function DELETE(request: Request) {
  return withAdminSecurityHeaders(await handleDelete(request));
}
