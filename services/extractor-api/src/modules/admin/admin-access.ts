import { extractorApiEnv } from "../../config/env.js";
import { getHeader, hashServerSideIdentity, type RequestHeaders } from "../request-identity.js";
import { runStoreTransaction } from "../storage/upstash-store.js";

import {
  recordAdminAuditEvent,
  type AdminAuditAction,
  type AdminAuditDetail,
  type AdminAuditOutcome
} from "./admin-audit.js";
import {
  getAdminRequestToken,
  matchAdminCredential,
  parseAdminCredentials,
  type AdminCredentialConfig
} from "./admin-auth.js";

/* Who made an authorized admin request, for the audit log. */
export interface AdminRequestContext {
  actor: string;
  ip: string;
}

export type AdminAccessResult =
  | ({ ok: true } & AdminRequestContext)
  | {
      headers: Record<string, string>;
      message: string;
      ok: false;
      status: 401 | 403 | 404 | 415 | 429;
    };

export interface AdminAccessRequest {
  adapter: "fastify" | "vercel";
  headers: RequestHeaders;
  ip: string;
  method: string;
  path: string;
  /* Fastify only: with no admin tokens configured, loopback callers are let in. */
  isLoopback?: boolean;
}

const basicChallenge = { "www-authenticate": 'Basic realm="LinkDish Admin", charset="UTF-8"' };
const adminAuthFailureVersion = "v1";
/* A stalled store must degrade to the token-only check, not hold every admin request. */
const adminStoreTimeoutMs = 1_500;

let cachedCredentialConfig: AdminCredentialConfig | null = null;

export const getAdminCredentialConfig = (): AdminCredentialConfig => {
  cachedCredentialConfig ??= parseAdminCredentials(extractorApiEnv);
  return cachedCredentialConfig;
};

export const isAdminAuthConfigured = (): boolean =>
  getAdminCredentialConfig().credentials.length > 0;

export const getAdminAuthMode = (): string => {
  const { credentials } = getAdminCredentialConfig();
  const named = credentials.filter((credential) => credential.source === "ADMIN_DASHBOARD_TOKENS");
  const hasLegacy = credentials.some((credential) => credential.source === "ADMIN_DASHBOARD_TOKEN");

  if (credentials.length === 0) {
    return "Localhost only until ADMIN_DASHBOARD_TOKENS is set";
  }

  if (named.length === 0) {
    return "Shared ADMIN_DASHBOARD_TOKEN (legacy)";
  }

  return `Named tokens: ${named.map((credential) => credential.name).join(", ")}${
    hasLegacy ? " + shared legacy token" : ""
  }`;
};

const getFailureKey = (ip: string): string =>
  `linkdish:admin:auth-failures:${adminAuthFailureVersion}:${hashServerSideIdentity(
    "admin-auth-failures",
    ip
  )}`;

const getFailureWindowSeconds = (): number =>
  Math.max(1, Math.ceil(extractorApiEnv.ADMIN_AUTH_FAILURE_LIMIT_WINDOW_MS / 1000));

const toCount = (value: unknown): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

/*
 * The limiter fails open: if Upstash is down the token check still runs, so an outage does
 * not lock the owner out of the dashboard they would use to diagnose it. Tokens are long and
 * random, so the limiter is defence in depth rather than the only barrier.
 */
const readFailureState = async (
  key: string
): Promise<{ count: number; retryAfterSeconds: number }> => {
  try {
    const [count, ttl] = await runStoreTransaction(
      [
        ["GET", key],
        ["TTL", key]
      ],
      { timeoutMs: adminStoreTimeoutMs }
    );
    const ttlSeconds = toCount(ttl?.result);

    return {
      count: toCount(count?.result),
      retryAfterSeconds: ttlSeconds > 0 ? ttlSeconds : getFailureWindowSeconds()
    };
  } catch (error) {
    console.error("Admin auth limiter unavailable; allowing the token check.", error);
    return { count: 0, retryAfterSeconds: getFailureWindowSeconds() };
  }
};

/* INCR is the atomic step: concurrent bad guesses each get their own count, so a burst
 * cannot all slip under the limit the way a read-then-increment would. */
const incrementFailures = async (
  key: string
): Promise<{ count: number; retryAfterSeconds: number }> => {
  try {
    const [count, , ttl] = await runStoreTransaction(
      [
        ["INCR", key],
        ["EXPIRE", key, String(getFailureWindowSeconds()), "NX"],
        ["TTL", key]
      ],
      { timeoutMs: adminStoreTimeoutMs }
    );
    const ttlSeconds = toCount(ttl?.result);

    return {
      count: toCount(count?.result),
      retryAfterSeconds: ttlSeconds > 0 ? ttlSeconds : getFailureWindowSeconds()
    };
  } catch (error) {
    console.error("Admin auth limiter unavailable; failure not counted.", error);
    return { count: 0, retryAfterSeconds: getFailureWindowSeconds() };
  }
};

const isWriteMethod = (method: string): boolean =>
  !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/*
 * Browsers replay cached Basic credentials on cross-site requests, so a write must come from
 * the dashboard itself: same-origin by Fetch Metadata, and with a JSON body (which a plain
 * HTML form or a no-preflight fetch cannot send).
 */
const getCrossSiteWriteFailure = (request: AdminAccessRequest): AdminAccessResult | null => {
  if (!isWriteMethod(request.method)) {
    return null;
  }

  const fetchSite = getHeader(request.headers, "sec-fetch-site");

  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return {
      headers: {},
      message: "Cross-site admin requests are not allowed.",
      ok: false,
      status: 403
    };
  }

  const method = request.method.toUpperCase();
  const contentType = getHeader(request.headers, "content-type") ?? "";

  if ((method === "POST" || method === "PUT") && !/^application\/json\b/iu.test(contentType)) {
    return {
      headers: {},
      message: "Admin writes must send application/json.",
      ok: false,
      status: 415
    };
  }

  return null;
};

/**
 * Authorizes one admin request: the dashboard switch, the cross-site write guard, the
 * named-token check, then a per-IP lockout after repeated bad tokens. Bad tokens and lockouts are
 * written to the audit log; requests that present no credential (the browser's first hit
 * before its sign-in prompt) are not counted.
 */
export const authorizeAdminAccess = async (
  request: AdminAccessRequest
): Promise<AdminAccessResult> => {
  if (!extractorApiEnv.ADMIN_DASHBOARD_ENABLED) {
    return { headers: {}, message: "Admin dashboard is disabled.", ok: false, status: 404 };
  }

  const crossSiteFailure = getCrossSiteWriteFailure(request);

  if (crossSiteFailure) {
    return crossSiteFailure;
  }

  const { credentials } = getAdminCredentialConfig();

  if (credentials.length === 0) {
    if (request.isLoopback) {
      return { actor: "localhost", ip: request.ip, ok: true };
    }

    return request.adapter === "vercel"
      ? {
          headers: {},
          message: "Admin dashboard requires ADMIN_DASHBOARD_TOKENS on Vercel.",
          ok: false,
          status: 403
        }
      : {
          headers: basicChallenge,
          message: "Admin dashboard access denied.",
          ok: false,
          status: 401
        };
  }

  const requestToken = getAdminRequestToken(request.headers);

  if (!requestToken) {
    return {
      headers: basicChallenge,
      message: "Admin dashboard access denied.",
      ok: false,
      status: 401
    };
  }

  const failureKey = getFailureKey(request.ip);
  const limit = extractorApiEnv.ADMIN_AUTH_FAILURE_LIMIT_MAX;
  const lockedOut = (retryAfterSeconds: number): AdminAccessResult => ({
    headers: { "retry-after": String(retryAfterSeconds) },
    message: "Too many failed admin sign-ins from this network. Try again later.",
    ok: false,
    status: 429
  });
  const credential = matchAdminCredential(requestToken, credentials);

  /*
   * A valid token is still refused while its network is locked out; otherwise the lockout
   * would not stop a guess from succeeding.
   */
  if (credential) {
    const failureState = await readFailureState(failureKey);

    return failureState.count >= limit
      ? lockedOut(failureState.retryAfterSeconds)
      : { actor: credential.name, ip: request.ip, ok: true };
  }

  const failures = await incrementFailures(failureKey);

  /* Past the limit nothing more is audited, so one network adds at most `limit` entries. */
  if (failures.count > limit) {
    return lockedOut(failures.retryAfterSeconds);
  }

  const detail: AdminAuditDetail = {
    failures: failures.count,
    method: request.method.toUpperCase(),
    path: request.path,
    scheme: requestToken.scheme
  };

  await recordAdminAuditEvent({
    action: "auth.failed",
    actor: null,
    detail,
    ip: request.ip,
    outcome: "denied"
  });

  if (failures.count === limit) {
    await recordAdminAuditEvent({
      action: "auth.locked",
      actor: null,
      detail: { lockoutSeconds: getFailureWindowSeconds(), ...detail },
      ip: request.ip,
      outcome: "denied"
    });
  }

  return {
    headers: basicChallenge,
    message: "Admin dashboard access denied.",
    ok: false,
    status: 401
  };
};

export const recordAdminAction = (
  context: AdminRequestContext,
  action: AdminAuditAction,
  outcome: AdminAuditOutcome,
  detail?: AdminAuditDetail
) =>
  recordAdminAuditEvent({
    action,
    actor: context.actor,
    ...(detail ? { detail } : {}),
    ip: context.ip,
    outcome
  });
