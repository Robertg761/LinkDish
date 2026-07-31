import { afterEach, describe, expect, it, vi } from "vitest";

const importRateLimitModule = async (env?: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    BILLING_QUOTA_IDENTITY_SECRET: "test_rate_limit_secret",
    RATE_LIMIT_MAX: "2",
    RATE_LIMIT_WINDOW_MS: "60000",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  return import("./enforce-rate-limit.js");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("checkExtractRateLimit", () => {
  it("blocks requests over the in-memory network rate limit", async () => {
    const { checkExtractRateLimit } = await importRateLimitModule();
    const headers = {
      "x-forwarded-for": "203.0.113.60"
    };

    const firstResult = await checkExtractRateLimit(headers);
    const secondResult = await checkExtractRateLimit(headers);
    const thirdResult = await checkExtractRateLimit(headers);

    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        rateLimitCount: 1,
        rateLimitIdentity: "network",
        rateLimitLimit: 2
      }
    });
    expect(secondResult).toMatchObject({
      allowed: true,
      logContext: {
        rateLimitCount: 2
      }
    });
    expect(thirdResult).toMatchObject({
      allowed: false,
      headers: {
        "x-ratelimit-limit": "2",
        "x-ratelimit-remaining": "0"
      },
      logContext: {
        rateLimitCount: 3
      }
    });
  });

  it("does not reset the rate limit when callers rotate billing client ids", async () => {
    const { checkExtractRateLimit } = await importRateLimitModule({
      RATE_LIMIT_MAX: "1"
    });

    const firstResult = await checkExtractRateLimit({
      "x-forwarded-for": "203.0.113.61",
      "x-linkdish-client-id": "client-a"
    });
    const secondResult = await checkExtractRateLimit({
      "x-forwarded-for": "203.0.113.61",
      "x-linkdish-client-id": "client-b"
    });

    expect(firstResult.allowed).toBe(true);
    expect(secondResult).toMatchObject({
      allowed: false,
      logContext: {
        rateLimitCount: 2
      }
    });
  });

  it("does not fall back to rotated forwarding headers when explicit request identity is unknown", async () => {
    const { checkExtractRateLimit } = await importRateLimitModule({
      RATE_LIMIT_MAX: "1"
    });

    const firstResult = await checkExtractRateLimit(
      {
        "x-forwarded-for": "203.0.113.64"
      },
      {
        remoteAddress: "unknown"
      }
    );
    const secondResult = await checkExtractRateLimit(
      {
        "x-forwarded-for": "203.0.113.65"
      },
      {
        remoteAddress: "unknown"
      }
    );

    expect(firstResult.allowed).toBe(true);
    expect(secondResult).toMatchObject({
      allowed: false,
      logContext: {
        rateLimitCount: 2
      }
    });
  });

  it("uses trusted remote identity instead of rotated forwarding headers for rate limits", async () => {
    const { checkExtractRateLimit } = await importRateLimitModule({
      RATE_LIMIT_MAX: "1"
    });

    const firstResult = await checkExtractRateLimit(
      {
        "x-forwarded-for": "203.0.113.66"
      },
      {
        remoteAddress: "198.51.100.2"
      }
    );
    const secondResult = await checkExtractRateLimit(
      {
        "x-forwarded-for": "203.0.113.67"
      },
      {
        remoteAddress: "198.51.100.2"
      }
    );

    expect(firstResult.allowed).toBe(true);
    expect(secondResult).toMatchObject({
      allowed: false,
      logContext: {
        rateLimitCount: 2
      }
    });
  });

  it("uses Upstash when durable serverless storage is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            result: 3
          },
          {
            result: 0
          },
          {
            result: 42
          }
        ]),
        {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { checkExtractRateLimit } = await importRateLimitModule({
      RATE_LIMIT_MAX: "2",
      UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
      UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
    });

    const result = await checkExtractRateLimit({
      "x-forwarded-for": "203.0.113.62"
    });

    const fetchCall = fetchMock.mock.calls[0];
    const requestBody = fetchCall?.[1]?.body;
    expect(fetchCall?.[0]).toBe("https://upstash.invalid/multi-exec");
    expect(fetchCall?.[1]?.method).toBe("POST");
    if (typeof requestBody !== "string") {
      throw new Error("Expected Upstash request body to be a string.");
    }
    expect(requestBody).toContain('"INCR"');
    expect(fetchCall?.[1]?.headers).toMatchObject({
      authorization: "Bearer test_upstash_token"
    });
    expect(result).toMatchObject({
      allowed: false,
      headers: {
        "retry-after": "42"
      },
      logContext: {
        rateLimitCount: 3,
        rateLimitLimit: 2
      },
      retryAfterSeconds: 42
    });
  });

  it("fails closed when the durable rate limit store is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "temporary outage" }), {
          headers: {
            "content-type": "application/json"
          },
          status: 503
        })
      )
    );
    const { checkExtractRateLimit, RateLimitUnavailableError } = await importRateLimitModule({
      UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
      UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
    });

    await expect(
      checkExtractRateLimit({
        "x-forwarded-for": "203.0.113.63"
      })
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });
});

describe("checkPublicEndpointRateLimit", () => {
  it("uses independent limits for each public endpoint scope", async () => {
    const { checkPublicEndpointRateLimit } = await importRateLimitModule();
    const headers = {
      "x-forwarded-for": "203.0.113.70"
    };
    const supportPolicy = {
      max: 1,
      scope: "support-ticket" as const,
      windowMs: 60_000
    };
    const imagePolicy = {
      max: 1,
      scope: "image" as const,
      windowMs: 60_000
    };

    expect((await checkPublicEndpointRateLimit(headers, supportPolicy)).allowed).toBe(true);
    expect((await checkPublicEndpointRateLimit(headers, supportPolicy)).allowed).toBe(false);
    expect((await checkPublicEndpointRateLimit(headers, imagePolicy)).allowed).toBe(true);
  });

  it("uses the public endpoint window when creating the durable key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ result: 1 }, { result: 1 }, { result: 300 }]), {
        headers: {
          "content-type": "application/json"
        },
        status: 200
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { checkPublicEndpointRateLimit } = await importRateLimitModule({
      UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
      UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
    });

    await checkPublicEndpointRateLimit(
      {
        "x-forwarded-for": "203.0.113.71"
      },
      {
        max: 5,
        scope: "support-ticket",
        windowMs: 300_000
      }
    );

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    expect(requestBody).toContain('"EXPIRE"');
    expect(requestBody).toContain('"300"');
    expect(requestBody).toContain("support-ticket");
  });
});
