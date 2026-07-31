import { z } from "zod";

import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import {
  hasValidAdminToken,
  withAdminSecurityHeaders
} from "../services/extractor-api/src/modules/admin/admin-auth.js";
import {
  AdminBillingGrantError,
  adminBillingGrantRequestSchema,
  grantBillingPlanByEmail
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

const authorizeAdminRequest = (request: Request): Response | null => {
  if (!extractorApiEnv.ADMIN_DASHBOARD_ENABLED) {
    return Response.json(
      {
        message: "Admin dashboard is disabled."
      },
      {
        status: 404
      }
    );
  }

  if (!extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
    return Response.json(
      {
        message: "Admin dashboard requires ADMIN_DASHBOARD_TOKEN on Vercel."
      },
      {
        status: 403
      }
    );
  }

  if (!hasValidAdminToken(request.headers, extractorApiEnv.ADMIN_DASHBOARD_TOKEN)) {
    return Response.json(
      {
        message: "Admin dashboard access denied."
      },
      {
        headers: {
          "www-authenticate": 'Basic realm="LinkDish Admin", charset="UTF-8"'
        },
        status: 401
      }
    );
  }

  return null;
};

const getAdminPath = (url: URL): string =>
  (url.searchParams.get("path") ?? "").replace(/^\/+|\/+$/gu, "");

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
  const authFailure = authorizeAdminRequest(request);

  if (authFailure) {
    return authFailure;
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
      return Response.json(await getAdminUserAccountDetails(parsedQuery.data));
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
  const authFailure = authorizeAdminRequest(request);

  if (authFailure) {
    return authFailure;
  }

  if (getAdminPath(url) !== "api/billing/grants") {
    return jsonError("Admin dashboard route not found.", 404);
  }

  if (!extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
    return jsonError("Billing grants require ADMIN_DASHBOARD_TOKEN.", 403);
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
    const grant = await grantBillingPlanByEmail(parsedBody.data, {
      grantedBy: "admin-api"
    });

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
  const authFailure = authorizeAdminRequest(request);

  if (authFailure) {
    return authFailure;
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
    const llm = await runtime.fallbackExtractor.updateSettings(parsedBody.data);

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
  const authFailure = authorizeAdminRequest(request);

  if (authFailure) {
    return authFailure;
  }

  if (getAdminPath(url) !== "api/llm") {
    return jsonError("Admin dashboard route not found.", 404);
  }

  const runtime = getSharedExtractorRuntime();

  if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
    return jsonError("This runtime does not support admin model changes.", 409);
  }

  try {
    const llm = await runtime.fallbackExtractor.resetSettingsToEnv();

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
