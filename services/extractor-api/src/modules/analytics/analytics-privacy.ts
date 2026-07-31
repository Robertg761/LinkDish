import { createHmac } from "node:crypto";

import { extractorApiEnv } from "../../config/env.js";

import type { AnalyticsEventProperties } from "../../../../../packages/api-contracts/src/index.js";

const blockedPropertyNames = new Set([
  "code",
  "email",
  "html",
  "image",
  "ingredients",
  "instructions",
  "jwt",
  "recipe",
  "recipe_title",
  "recipetitle",
  "source_url",
  "sourceurl",
  "text",
  "token",
  "transcript",
  "url"
]);

const normalizePropertyName = (name: string): string => name.trim().replace(/[^a-z0-9_:-]/giu, "_");

const isBlockedPropertyName = (name: string): boolean =>
  blockedPropertyNames.has(
    name
      .trim()
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase()
  );

export const sanitizeAnalyticsProperties = (
  properties: AnalyticsEventProperties
): AnalyticsEventProperties => {
  const sanitized: AnalyticsEventProperties = {};

  for (const [rawKey, value] of Object.entries(properties)) {
    if (isBlockedPropertyName(rawKey)) {
      continue;
    }

    const key = normalizePropertyName(rawKey).slice(0, 80);

    if (!key) {
      continue;
    }

    sanitized[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }

  return sanitized;
};

export const getSourceHostname = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
};

export const hashAnalyticsUserId = (userId: string): string =>
  createHmac(
    "sha256",
    extractorApiEnv.ANALYTICS_HASH_SECRET ??
      extractorApiEnv.AUTH_SECRET ??
      extractorApiEnv.BILLING_QUOTA_IDENTITY_SECRET ??
      "development"
  )
    .update("linkdish-analytics-user-v1")
    .update("\0")
    .update(userId)
    .digest("hex");
