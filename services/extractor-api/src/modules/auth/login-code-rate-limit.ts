import { extractorApiEnv } from "../../config/env.js";
import {
  getRequestAddress,
  hashServerSideIdentity,
  type RequestHeaders,
  type RequestIdentity
} from "../request-identity.js";
import { runStoreTransaction } from "../storage/upstash-store.js";

interface LoginCodeRateLimitResult {
  allowed: boolean;
  headers: Record<string, string>;
  logContext: {
    loginCodeRateLimitCount: number | null;
    loginCodeRateLimitIdentity: "network";
    loginCodeRateLimitLimit: number;
    loginCodeRateLimitWindowMs: number;
  };
  retryAfterSeconds: number;
}

interface StoreResponse {
  error?: string;
  result?: unknown;
}

export class LoginCodeRateLimitUnavailableError extends Error {
  public readonly statusCode = 503;

  public constructor(message: string) {
    super(message);
    this.name = "LoginCodeRateLimitUnavailableError";
  }
}

const loginCodeRateLimitVersion = "v1";
export const loginCodeRateLimitExceededMessage =
  "Too many sign-in code requests from this network. Please try again shortly.";
const loginCodeRateLimitUnavailableMessage =
  "LinkDish could not verify sign-in code limits right now. Please try again shortly.";

const getWindowSeconds = (): number =>
  Math.max(1, Math.ceil(extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS / 1000));

const getLoginCodeRateLimitKey = (headers: RequestHeaders, identity?: RequestIdentity): string =>
  `linkdish:auth-login-code-rate-limit:${loginCodeRateLimitVersion}:network:${hashServerSideIdentity(
    "auth-login-code-rate-limit",
    getRequestAddress(headers, identity)
  )}`;

const getNumericResult = (entry: StoreResponse | undefined, label: string): number => {
  if (entry?.error) {
    throw new LoginCodeRateLimitUnavailableError(loginCodeRateLimitUnavailableMessage);
  }

  const value = typeof entry?.result === "string" ? Number(entry.result) : entry?.result;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LoginCodeRateLimitUnavailableError(
      `Login-code rate limit ${label} returned an invalid response.`
    );
  }

  return Math.floor(value);
};

export const checkLoginCodeRateLimit = async (
  headers: RequestHeaders,
  identity?: RequestIdentity
): Promise<LoginCodeRateLimitResult> => {
  const key = getLoginCodeRateLimitKey(headers, identity);
  const windowSeconds = getWindowSeconds();
  let body: StoreResponse[];

  try {
    body = await runStoreTransaction([
      ["INCR", key],
      ["EXPIRE", key, String(windowSeconds), "NX"],
      ["TTL", key]
    ]);
  } catch {
    throw new LoginCodeRateLimitUnavailableError(loginCodeRateLimitUnavailableMessage);
  }

  const count = Math.max(0, getNumericResult(body[0], "increment"));
  getNumericResult(body[1], "expiry");
  const ttlSeconds = getNumericResult(body[2], "ttl");
  const retryAfterSeconds = ttlSeconds > 0 ? ttlSeconds : windowSeconds;
  const remaining = Math.max(0, extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX - count);
  const allowed = count <= extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX;

  return {
    allowed,
    headers: {
      "retry-after": String(retryAfterSeconds),
      "x-ratelimit-limit": String(extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + retryAfterSeconds)
    },
    logContext: {
      loginCodeRateLimitCount: count,
      loginCodeRateLimitIdentity: "network",
      loginCodeRateLimitLimit: extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_MAX,
      loginCodeRateLimitWindowMs: extractorApiEnv.AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS
    },
    retryAfterSeconds
  };
};
