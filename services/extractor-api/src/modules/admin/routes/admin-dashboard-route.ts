import { z } from "zod";

import { extractorApiEnv } from "../../../config/env.js";
import { adminSecurityHeaders, hasValidAdminToken } from "../admin-auth.js";
import {
  AdminBillingGrantError,
  adminBillingGrantRequestSchema,
  grantBillingPlanByEmail
} from "../billing-grants.js";
import { adminDashboardHtml } from "../dashboard-assets.js";
import { getAdminDashboardSnapshot } from "../dashboard-snapshot.js";
import { parseAdminEnvironmentName } from "../environment-profiles.js";
import { AdminModelSettingsValidationError, isManagedFallbackExtractor } from "../model-control.js";
import { AdminModelSettingsStoreUnavailableError } from "../model-settings-store.js";
import {
  AdminUserAccountError,
  adminUserLookupQuerySchema,
  getAdminUserAccountDetails
} from "../user-accounts.js";

import type { ExtractorRuntime } from "../../extract/types.js";
import type { FastifyInstance, FastifyRequest } from "fastify";

const modelUpdateSchema = z.object({
  provider: z.enum(["gemini", "openai", "none"]).optional(),
  model: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value === "" ? undefined : value))
});

const isLoopbackRequest = (request: FastifyRequest): boolean =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);

export const getAdminDashboardAuthMode = (): string => {
  if (extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
    return "ADMIN_DASHBOARD_TOKEN";
  }

  return "Localhost only until ADMIN_DASHBOARD_TOKEN is set";
};

export const authorizeAdminRequest = (request: FastifyRequest): boolean => {
  if (!extractorApiEnv.ADMIN_DASHBOARD_ENABLED) {
    return false;
  }

  if (!extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
    return isLoopbackRequest(request);
  }

  return hasValidAdminToken(request.headers, extractorApiEnv.ADMIN_DASHBOARD_TOKEN);
};

export const registerAdminDashboardRoutes = (app: FastifyInstance, runtime: ExtractorRuntime) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) {
      return;
    }

    reply.headers(adminSecurityHeaders);

    if (!authorizeAdminRequest(request)) {
      if (extractorApiEnv.ADMIN_DASHBOARD_ENABLED) {
        reply.header("www-authenticate", 'Basic realm="LinkDish Admin", charset="UTF-8"');
      }

      return reply.status(extractorApiEnv.ADMIN_DASHBOARD_ENABLED ? 401 : 404).send({
        message: extractorApiEnv.ADMIN_DASHBOARD_ENABLED
          ? "Admin dashboard access denied."
          : "Admin dashboard is disabled."
      });
    }
  });

  app.get("/admin", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(adminDashboardHtml)
  );

  app.get("/admin/api/dashboard", async (request) => {
    const query = request.query as { environment?: unknown };

    return getAdminDashboardSnapshot(
      runtime,
      parseAdminEnvironmentName(query.environment) ?? "development"
    );
  });

  app.get("/admin/api/users", async (request, reply) => {
    const parsedQuery = adminUserLookupQuerySchema.safeParse(request.query);

    if (!parsedQuery.success) {
      return reply.status(400).send({
        message: "Invalid user lookup.",
        issues: parsedQuery.error.issues
      });
    }

    try {
      return await getAdminUserAccountDetails(parsedQuery.data);
    } catch (error) {
      if (error instanceof AdminUserAccountError) {
        return reply.status(error.statusCode).send({
          message: error.message
        });
      }

      throw error;
    }
  });

  app.put("/admin/api/llm", async (request, reply) => {
    if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
      return reply.status(409).send({
        message: "This runtime does not support admin model changes."
      });
    }

    const parsedBody = modelUpdateSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.status(400).send({
        message: "Invalid model update.",
        issues: parsedBody.error.issues
      });
    }

    try {
      const llm = await runtime.fallbackExtractor.updateSettings(parsedBody.data);

      return {
        llm,
        snapshot: await getAdminDashboardSnapshot(runtime)
      };
    } catch (error) {
      if (error instanceof AdminModelSettingsStoreUnavailableError) {
        return reply.status(503).send({
          message: "Could not persist model settings.",
          detail: error.message
        });
      }

      if (error instanceof AdminModelSettingsValidationError) {
        return reply.status(400).send({
          message: "Invalid model settings.",
          detail: error.message
        });
      }

      throw error;
    }
  });

  app.delete("/admin/api/llm", async (_request, reply) => {
    if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
      return reply.status(409).send({
        message: "This runtime does not support admin model changes."
      });
    }

    try {
      const llm = await runtime.fallbackExtractor.resetSettingsToEnv();

      return {
        llm,
        snapshot: await getAdminDashboardSnapshot(runtime)
      };
    } catch (error) {
      if (error instanceof AdminModelSettingsStoreUnavailableError) {
        return reply.status(503).send({
          message: "Could not reset persisted model settings.",
          detail: error.message
        });
      }

      throw error;
    }
  });

  app.post("/admin/api/billing/grants", async (request, reply) => {
    if (!extractorApiEnv.ADMIN_DASHBOARD_TOKEN) {
      return reply.status(403).send({
        message: "Billing grants require ADMIN_DASHBOARD_TOKEN."
      });
    }

    const parsedBody = adminBillingGrantRequestSchema.safeParse(request.body);

    if (!parsedBody.success) {
      return reply.status(400).send({
        message: "Invalid billing grant request.",
        issues: parsedBody.error.issues
      });
    }

    try {
      const grant = await grantBillingPlanByEmail(parsedBody.data, {
        grantedBy: "admin-api"
      });

      return {
        ...grant,
        account: parsedBody.data.dryRun
          ? null
          : await getAdminUserAccountDetails({ email: parsedBody.data.email })
      };
    } catch (error) {
      if (error instanceof AdminBillingGrantError) {
        return reply.status(error.statusCode).send({
          detail: error.detail,
          message: error.message
        });
      }

      throw error;
    }
  });
};
