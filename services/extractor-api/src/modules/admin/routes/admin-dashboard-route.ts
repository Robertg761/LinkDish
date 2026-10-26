import { z } from "zod";

import {
  authorizeAdminAccess,
  isAdminAuthConfigured,
  type AdminRequestContext
} from "../admin-access.js";
import {
  grantAdminBillingPlan,
  lookupAdminUserAccount,
  resetAdminModelSettings,
  updateAdminModelSettings
} from "../admin-actions.js";
import { adminSecurityHeaders } from "../admin-auth.js";
import { AdminBillingGrantError, adminBillingGrantRequestSchema } from "../billing-grants.js";
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

const adminRequestContexts = new WeakMap<FastifyRequest, AdminRequestContext>();

const getAdminContext = (request: FastifyRequest): AdminRequestContext => {
  const context = adminRequestContexts.get(request);

  if (!context) {
    throw new Error("Admin route ran without an authorized admin context.");
  }

  return context;
};

export const registerAdminDashboardRoutes = (app: FastifyInstance, runtime: ExtractorRuntime) => {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin")) {
      return;
    }

    reply.headers(adminSecurityHeaders);

    const access = await authorizeAdminAccess({
      adapter: "fastify",
      headers: request.headers,
      ip: request.ip,
      isLoopback: isLoopbackRequest(request),
      method: request.method,
      path: request.url.split("?")[0] ?? request.url
    });

    if (!access.ok) {
      reply.headers(access.headers);
      return reply.status(access.status).send({
        message: access.message
      });
    }

    adminRequestContexts.set(request, { actor: access.actor, ip: access.ip });
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
      return await lookupAdminUserAccount(getAdminContext(request), parsedQuery.data);
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
      const llm = await updateAdminModelSettings(
        getAdminContext(request),
        runtime.fallbackExtractor,
        parsedBody.data
      );

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

  app.delete("/admin/api/llm", async (request, reply) => {
    if (!isManagedFallbackExtractor(runtime.fallbackExtractor)) {
      return reply.status(409).send({
        message: "This runtime does not support admin model changes."
      });
    }

    try {
      const llm = await resetAdminModelSettings(
        getAdminContext(request),
        runtime.fallbackExtractor
      );

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
    if (!isAdminAuthConfigured()) {
      return reply.status(403).send({
        message: "Billing grants require ADMIN_DASHBOARD_TOKENS."
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
      const grant = await grantAdminBillingPlan(getAdminContext(request), parsedBody.data);

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
