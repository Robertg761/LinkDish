import { timingSafeEqual } from "node:crypto";

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

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const getBearerToken = (authorizationHeader: string | null | undefined): string | null => {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim() || null;
};

const getBasicToken = (authorizationHeader: string | null | undefined): string | null => {
  if (!authorizationHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const credentials = Buffer.from(
      authorizationHeader.slice("Basic ".length).trim(),
      "base64"
    ).toString("utf8");
    const separatorIndex = credentials.indexOf(":");

    if (separatorIndex === -1 || credentials.slice(0, separatorIndex) !== "admin") {
      return null;
    }

    return credentials.slice(separatorIndex + 1) || null;
  } catch {
    return null;
  }
};

export const getAdminRequestToken = (headers: RequestHeaders): string | null => {
  const headerToken = getHeader(headers, "x-admin-dashboard-token")?.trim();

  if (headerToken) {
    return headerToken;
  }

  const authorization = getHeader(headers, "authorization");
  return getBearerToken(authorization) ?? getBasicToken(authorization);
};

export const hasValidAdminToken = (headers: RequestHeaders, expectedToken: string): boolean => {
  const requestToken = getAdminRequestToken(headers);
  return requestToken ? constantTimeEquals(requestToken, expectedToken) : false;
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
