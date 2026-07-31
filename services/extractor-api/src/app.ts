import { Readable } from "node:stream";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";

import { extractorApiEnv } from "./config/env.js";
import { registerAccountRoutes } from "./modules/account/routes/account-routes.js";
import { registerAdminDashboardRoutes } from "./modules/admin/routes/admin-dashboard-route.js";
import { closeAnalyticsStore } from "./modules/analytics/analytics-store.js";
import { registerAnalyticsRoutes } from "./modules/analytics/routes/analytics-routes.js";
import { registerAuthRoutes } from "./modules/auth/routes/auth-routes.js";
import { registerClerkWebhookRoutes } from "./modules/auth/routes/clerk-webhook-routes.js";
import { registerBillingRoutes } from "./modules/billing/routes/billing-routes.js";
import { registerRevenueCatWebhookRoutes } from "./modules/billing/routes/revenuecat-webhook-routes.js";
import { registerDebugRoutes } from "./modules/debug/routes/debug-routes.js";
import { registerExtractRoute } from "./modules/extract/routes/extract-route.js";
import { getSharedExtractorRuntime } from "./modules/extract/services/runtime.js";
import { registerHouseholdRoutes } from "./modules/households/routes/household-routes.js";
import { registerImageRoute } from "./modules/image/image-proxy.js";
import { registerIosWaitlistRoutes } from "./modules/waitlist/routes/ios-waitlist-routes.js";

import type { ExtractorRuntime } from "./modules/extract/types.js";

export const buildApp = (options?: { runtime?: ExtractorRuntime }) => {
  const runtime = options?.runtime ?? getSharedExtractorRuntime();
  const app = Fastify({
    bodyLimit: 8 * 1024 * 1024,
    logger: true
  });

  const corsOriginOption = (() => {
    if (extractorApiEnv.CORS_ORIGIN === "*") {
      return true;
    }
    if (extractorApiEnv.CORS_ORIGIN.includes(",")) {
      return extractorApiEnv.CORS_ORIGIN.split(",").map((origin) => origin.trim());
    }
    return extractorApiEnv.CORS_ORIGIN;
  })();

  app.register(cors, {
    origin: corsOriginOption
  });

  app.register(rateLimit, {
    allowList: ["127.0.0.1", "::1"],
    global: true,
    max: extractorApiEnv.RATE_LIMIT_MAX,
    timeWindow: extractorApiEnv.RATE_LIMIT_WINDOW_MS
  });

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!new Set(["/webhooks/clerk", "/webhooks/revenuecat"]).has(request.url)) {
      return payload;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of payload as AsyncIterable<Buffer | string | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks);
    (request as typeof request & { rawBody?: string }).rawBody = rawBody.toString("utf8");
    return Readable.from([rawBody]);
  });

  app.get("/health", () => ({
    ok: true
  }));

  app.addHook("onClose", async () => {
    await closeAnalyticsStore();
    await runtime.dispose();
  });

  registerAdminDashboardRoutes(app, runtime);
  registerAnalyticsRoutes(app);
  registerClerkWebhookRoutes(app);
  registerRevenueCatWebhookRoutes(app);
  if (extractorApiEnv.NODE_ENV !== "production") {
    registerDebugRoutes(app);
  }
  registerAuthRoutes(app);
  registerBillingRoutes(app);
  registerAccountRoutes(app);
  registerHouseholdRoutes(app);
  registerIosWaitlistRoutes(app);
  registerImageRoute(app);
  registerExtractRoute(app, runtime);

  return app;
};
