import { extractorApiEnv } from "../../config/env.js";
import {
  getRequestAddress,
  hashServerSideIdentity,
  type RequestHeaders,
  type RequestIdentity
} from "../request-identity.js";

interface UpstashResponse {
  error?: string;
  result?: unknown;
}

interface InMemoryRateLimitEntry {
  count: number;
  resetAtMs: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  headers: Record<string, string>;
  logContext: {
    rateLimitCount: number | null;
    rateLimitIdentity: "network";
    rateLimitLimit: number;
    rateLimitWindowMs: number;
  };
  retryAfterSeconds: number;
}

export class RateLimitUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RateLimitUnavailableError";
  }
}

const inMemoryRateLimitCounts = new Map<string, InMemoryRateLimitEntry>();
const rateLimitVersion = "v1";

export interface PublicEndpointRateLimitPolicy {
  max: number;
  scope: "analytics" | "image" | "support-ticket";
  windowMs: number;
}

const getWindowSeconds = (windowMs: number): number => Math.max(1, Math.ceil(windowMs / 1000));

const getRateLimitKey = (
  headers: RequestHeaders,
  identity?: RequestIdentity,
  scope?: PublicEndpointRateLimitPolicy["scope"]
): string => {
  const address = getRequestAddress(headers, identity);

  return scope
    ? `linkdish:rate-limit:${rateLimitVersion}:${scope}:network:${hashServerSideIdentity(
        `rate-limit:${scope}`,
        address
      )}`
    : `linkdish:rate-limit:${rateLimitVersion}:network:${hashServerSideIdentity(
        "rate-limit",
        address
      )}`;
};

const getNumericResult = (entry: UpstashResponse | undefined, label: string): number => {
  if (entry?.error) {
    throw new RateLimitUnavailableError(entry.error);
  }

  const value = typeof entry?.result === "string" ? Number(entry.result) : entry?.result;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RateLimitUnavailableError(
      `Upstash rate limit ${label} returned an invalid response.`
    );
  }

  return Math.floor(value);
};

const checkRateLimitWithUpstash = async (
  key: string,
  windowMs: number
): Promise<{
  count: number;
  retryAfterSeconds: number;
}> => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new RateLimitUnavailableError("Upstash Redis REST is not configured.");
  }

  const response = await fetch(`${extractorApiEnv.UPSTASH_REDIS_REST_URL}/multi-exec`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(getWindowSeconds(windowMs)), "NX"],
      ["TTL", key]
    ])
  });

  if (!response.ok) {
    throw new RateLimitUnavailableError(`Upstash rate limit check failed with ${response.status}.`);
  }

  const body = (await response.json()) as UpstashResponse[];
  const count = Math.max(0, getNumericResult(body[0], "increment"));
  const ttlSeconds = getNumericResult(body[2], "ttl");

  return {
    count,
    retryAfterSeconds: ttlSeconds > 0 ? ttlSeconds : getWindowSeconds(windowMs)
  };
};

const checkRateLimitInMemory = (
  key: string,
  windowMs: number
): {
  count: number;
  retryAfterSeconds: number;
} => {
  const now = Date.now();
  const existingEntry = inMemoryRateLimitCounts.get(key);
  const entry =
    existingEntry && existingEntry.resetAtMs > now
      ? existingEntry
      : {
          count: 0,
          resetAtMs: now + windowMs
        };

  entry.count += 1;
  inMemoryRateLimitCounts.set(key, entry);

  return {
    count: entry.count,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtMs - now) / 1000))
  };
};

const checkRateLimit = async (
  headers: RequestHeaders,
  options: {
    identity?: RequestIdentity;
    max: number;
    scope?: PublicEndpointRateLimitPolicy["scope"];
    windowMs: number;
  }
): Promise<RateLimitCheckResult> => {
  const key = getRateLimitKey(headers, options.identity, options.scope);
  const usage =
    extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN
      ? await checkRateLimitWithUpstash(key, options.windowMs)
      : checkRateLimitInMemory(key, options.windowMs);
  const remaining = Math.max(0, options.max - usage.count);
  const allowed = usage.count <= options.max;

  return {
    allowed,
    headers: {
      "retry-after": String(usage.retryAfterSeconds),
      "x-ratelimit-limit": String(options.max),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + usage.retryAfterSeconds)
    },
    logContext: {
      rateLimitCount: usage.count,
      rateLimitIdentity: "network",
      rateLimitLimit: options.max,
      rateLimitWindowMs: options.windowMs
    },
    retryAfterSeconds: usage.retryAfterSeconds
  };
};

export const checkExtractRateLimit = (
  headers: RequestHeaders,
  identity?: RequestIdentity
): Promise<RateLimitCheckResult> =>
  checkRateLimit(headers, {
    ...(identity ? { identity } : {}),
    max: extractorApiEnv.RATE_LIMIT_MAX,
    windowMs: extractorApiEnv.RATE_LIMIT_WINDOW_MS
  });

export const checkPublicEndpointRateLimit = (
  headers: RequestHeaders,
  policy: PublicEndpointRateLimitPolicy,
  identity?: RequestIdentity
): Promise<RateLimitCheckResult> =>
  checkRateLimit(headers, {
    ...(identity ? { identity } : {}),
    ...policy
  });
