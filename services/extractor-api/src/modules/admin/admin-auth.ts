import { createHash, timingSafeEqual } from "node:crypto";

import { getHeader, type RequestHeaders } from "../request-identity.js";

export const adminSecurityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;

/* The Basic-auth username that goes with the legacy shared ADMIN_DASHBOARD_TOKEN. */
export const legacyAdminActorName = "admin";
export const minimumAdminTokenLength = 32;

const adminActorNamePattern = /^[a-z0-9][a-z0-9._-]{0,39}$/u;

export interface AdminCredential {
  name: string;
  source: "ADMIN_DASHBOARD_TOKEN" | "ADMIN_DASHBOARD_TOKENS";
  token: string;
}

export interface AdminCredentialConfig {
  credentials: AdminCredential[];
  issues: string[];
}

export type AdminTokenScheme = "basic" | "bearer" | "header";

export interface AdminRequestToken {
  scheme: AdminTokenScheme;
  token: string;
  username?: string;
}

/**
 * Builds the admin credential list. ADMIN_DASHBOARD_TOKENS holds one named token per person
 * ("robert:<token>,ops:<token>") so each action is attributable and a single token can be
 * revoked; the legacy shared ADMIN_DASHBOARD_TOKEN keeps working as the "admin" user.
 * Malformed entries are skipped and reported as issues instead of throwing, because every
 * API function loads this env and one bad admin entry must not take the API down.
 */
export const parseAdminCredentials = (env: {
  ADMIN_DASHBOARD_TOKEN?: string | undefined;
  ADMIN_DASHBOARD_TOKENS?: string | undefined;
}): AdminCredentialConfig => {
  const credentials: AdminCredential[] = [];
  const issues: string[] = [];
  const addCredential = (credential: AdminCredential) => {
    if (credentials.some((existing) => existing.name === credential.name)) {
      issues.push(`Admin user "${credential.name}" is configured more than once; using the first.`);
      return;
    }

    if (credentials.some((existing) => existing.token === credential.token)) {
      issues.push(`Admin user "${credential.name}" reuses another user's token and was skipped.`);
      return;
    }

    if (credential.token.length < minimumAdminTokenLength) {
      issues.push(
        `The admin token for "${credential.name}" is shorter than ${minimumAdminTokenLength} characters. Replace it with \`openssl rand -hex 32\`.`
      );
    }

    credentials.push(credential);
  };

  for (const [index, rawEntry] of (env.ADMIN_DASHBOARD_TOKENS ?? "").split(",").entries()) {
    const entry = rawEntry.trim();

    if (!entry) {
      continue;
    }

    const separatorIndex = entry.indexOf(":");
    const name = separatorIndex === -1 ? "" : entry.slice(0, separatorIndex).trim().toLowerCase();
    const token = separatorIndex === -1 ? "" : entry.slice(separatorIndex + 1).trim();

    if (!adminActorNamePattern.test(name) || !token) {
      issues.push(
        `ADMIN_DASHBOARD_TOKENS entry ${index + 1} is not "name:token" with a lowercase name; it was skipped.`
      );
      continue;
    }

    addCredential({ name, source: "ADMIN_DASHBOARD_TOKENS", token });
  }

  if (env.ADMIN_DASHBOARD_TOKEN) {
    addCredential({
      name: legacyAdminActorName,
      source: "ADMIN_DASHBOARD_TOKEN",
      token: env.ADMIN_DASHBOARD_TOKEN
    });
  }

  return { credentials, issues };
};

/* Hashing first gives equal-length buffers, so neither the content nor the length leaks. */
const constantTimeEquals = (left: string, right: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest()
  );

const getBearerToken = (authorizationHeader: string | null | undefined): string | null => {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim() || null;
};

const getBasicCredentials = (
  authorizationHeader: string | null | undefined
): { token: string; username: string } | null => {
  if (!authorizationHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const credentials = Buffer.from(
      authorizationHeader.slice("Basic ".length).trim(),
      "base64"
    ).toString("utf8");
    const separatorIndex = credentials.indexOf(":");

    if (separatorIndex === -1) {
      return null;
    }

    const token = credentials.slice(separatorIndex + 1);

    return token
      ? { token, username: credentials.slice(0, separatorIndex).trim().toLowerCase() }
      : null;
  } catch {
    return null;
  }
};

export const getAdminRequestToken = (headers: RequestHeaders): AdminRequestToken | null => {
  const headerToken = getHeader(headers, "x-admin-dashboard-token")?.trim();

  if (headerToken) {
    return { scheme: "header", token: headerToken };
  }

  const authorization = getHeader(headers, "authorization");
  const bearerToken = getBearerToken(authorization);

  if (bearerToken) {
    return { scheme: "bearer", token: bearerToken };
  }

  const basic = getBasicCredentials(authorization);
  return basic ? { scheme: "basic", ...basic } : null;
};

/**
 * Returns the credential the presented token belongs to. Every configured token is compared
 * (no early exit) so timing does not reveal which entry matched. Basic auth must also name
 * the matching user, which is what the browser prompt asks for.
 */
export const matchAdminCredential = (
  requestToken: AdminRequestToken,
  credentials: readonly AdminCredential[]
): AdminCredential | null => {
  let matched: AdminCredential | null = null;

  for (const credential of credentials) {
    if (constantTimeEquals(requestToken.token, credential.token) && !matched) {
      matched = credential;
    }
  }

  if (matched && requestToken.scheme === "basic" && requestToken.username !== matched.name) {
    return null;
  }

  return matched;
};

/* Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; nothing else is accepted. */
export const hasValidCronSecret = (headers: RequestHeaders, expectedSecret: string): boolean => {
  const requestSecret = getBearerToken(getHeader(headers, "authorization"));
  return requestSecret ? constantTimeEquals(requestSecret, expectedSecret) : false;
};

export const withAdminSecurityHeaders = (response: Response): Response => {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(adminSecurityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
};
