import { createHash, timingSafeEqual } from "node:crypto";

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

/*
 * Forwarded headers are client-controlled unless a trusted proxy overwrites
 * them, and the Fastify server sets no trustProxy. Every caller therefore
 * passes a trusted `identity` (Vercel's ipAddress() helper for the serverless
 * handlers, request.ip for Fastify); this chain is only a last-resort fallback
 * for local tooling and must not be relied on for abuse controls.
 */
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

/*
 * The post-deploy live canary marks its requests, and they skip durable
 * analytics. The marker is caller-controlled, so it must never unlock anything
 * that affects other callers (billing, the shared result cache): those use
 * isAuthorizedCanaryRequest.
 */
export const isLiveCanaryRequest = (headers: RequestHeaders): boolean =>
  getHeader(headers, "x-linkdish-canary") != null ||
  getHeader(headers, "x-linkdish-client-id") === "live-canary";

/**
 * True only for the live canary presenting the server's LINKDISH_CANARY_TOKEN as a bearer
 * token. Billing exempts it, and it alone may read around the result cache and refresh it.
 */
export const isAuthorizedCanaryRequest = (headers: RequestHeaders): boolean => {
  const canaryToken = extractorApiEnv.LINKDISH_CANARY_TOKEN?.trim();

  if (!canaryToken) {
    return false;
  }

  const authorization = getHeader(headers, "authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const presentedToken = authorization.slice("Bearer ".length).trim();

  if (!presentedToken) {
    return false;
  }

  return timingSafeEqual(
    createHash("sha256").update(canaryToken).digest(),
    createHash("sha256").update(presentedToken).digest()
  );
};

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
