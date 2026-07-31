import { createHash } from "node:crypto";

import { extractorApiEnv } from "../config/env.js";

export type RequestHeaders = Headers | Record<string, string | string[] | undefined>;

export interface RequestIdentity {
  remoteAddress?: string | null;
}

const normalizeHeaderValue = (value: string | string[] | undefined): string | null => {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const normalizedValue = rawValue?.trim();
  return normalizedValue ? normalizedValue : null;
};

export const getHeader = (headers: RequestHeaders, name: string): string | null => {
  if (headers instanceof Headers) {
    return normalizeHeaderValue(headers.get(name) ?? undefined);
  }

  return normalizeHeaderValue(headers[name] ?? headers[name.toLowerCase()]);
};

const getForwardedAddress = (headers: RequestHeaders): string | null => {
  const forwardedValue =
    getHeader(headers, "x-vercel-forwarded-for") ??
    getHeader(headers, "x-real-ip") ??
    getHeader(headers, "cf-connecting-ip") ??
    getHeader(headers, "x-forwarded-for");
  const firstAddress = forwardedValue?.split(",")[0]?.trim();
  return firstAddress || null;
};

export const getRequestAddress = (headers: RequestHeaders, identity?: RequestIdentity): string =>
  identity
    ? identity.remoteAddress?.trim() || "unknown"
    : (getForwardedAddress(headers) ?? "unknown");

export const hashServerSideIdentity = (purpose: string, value: string): string =>
  createHash("sha256")
    .update(`linkdish-${purpose}-v1`)
    .update("\0")
    .update(
      extractorApiEnv.BILLING_QUOTA_IDENTITY_SECRET ??
        extractorApiEnv.REVENUECAT_SECRET_API_KEY ??
        "development"
    )
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 32);
