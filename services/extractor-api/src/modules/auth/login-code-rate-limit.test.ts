import { afterEach, describe, expect, it, vi } from "vitest";

const importLoginCodeRateLimitModule = async (env?: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    AUTH_LOGIN_CODE_RATE_LIMIT_MAX: "2",
    AUTH_LOGIN_CODE_RATE_LIMIT_WINDOW_MS: "600000",
    BILLING_QUOTA_IDENTITY_SECRET: "test_auth_rate_limit_secret",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  return import("./login-code-rate-limit.js");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("checkLoginCodeRateLimit", () => {
  it("blocks login-code requests over the in-memory network limit", async () => {
    const { checkLoginCodeRateLimit } = await importLoginCodeRateLimitModule();
    const headers = {
      "x-forwarded-for": "203.0.113.80"
    };

    const firstResult = await checkLoginCodeRateLimit(headers);
    const secondResult = await checkLoginCodeRateLimit(headers);
    const thirdResult = await checkLoginCodeRateLimit(headers);

    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        loginCodeRateLimitCount: 1,
        loginCodeRateLimitIdentity: "network",
        loginCodeRateLimitLimit: 2
      }
    });
    expect(secondResult).toMatchObject({
      allowed: true,
      logContext: {
        loginCodeRateLimitCount: 2
      }
    });
    expect(thirdResult).toMatchObject({
      allowed: false,
      headers: {
        "x-ratelimit-limit": "2",
        "x-ratelimit-remaining": "0"
      },
      logContext: {
        loginCodeRateLimitCount: 3
      }
    });
  });

  it("does not reset the login-code limit when callers rotate client ids", async () => {
    const { checkLoginCodeRateLimit } = await importLoginCodeRateLimitModule({
      AUTH_LOGIN_CODE_RATE_LIMIT_MAX: "1"
    });

    const firstResult = await checkLoginCodeRateLimit({
      "x-forwarded-for": "203.0.113.81",
      "x-linkdish-client-id": "client-a"
    });
    const secondResult = await checkLoginCodeRateLimit({
      "x-forwarded-for": "203.0.113.81",
      "x-linkdish-client-id": "client-b"
    });

    expect(firstResult.allowed).toBe(true);
    expect(secondResult).toMatchObject({
      allowed: false,
      logContext: {
        loginCodeRateLimitCount: 2
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
            result: 1
          },
          {
            result: 120
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
    const { checkLoginCodeRateLimit } = await importLoginCodeRateLimitModule({
      AUTH_LOGIN_CODE_RATE_LIMIT_MAX: "2",
      UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
      UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
    });

    const result = await checkLoginCodeRateLimit({
      "x-forwarded-for": "203.0.113.82"
    });

    const fetchCall = fetchMock.mock.calls[0];
    const requestBody = fetchCall?.[1]?.body;
    expect(fetchCall?.[0]).toBe("https://upstash.invalid/multi-exec");
    expect(fetchCall?.[1]?.method).toBe("POST");
    if (typeof requestBody !== "string") {
      throw new Error("Expected Upstash request body to be a string.");
    }
    expect(requestBody).toContain('"INCR"');
    expect(requestBody).toContain('"EXPIRE"');
    expect(requestBody).toContain("linkdish:auth-login-code-rate-limit:v1:network:");
    expect(fetchCall?.[1]?.headers).toMatchObject({
      authorization: "Bearer test_upstash_token"
    });
    expect(result).toMatchObject({
      allowed: false,
      headers: {
        "retry-after": "120"
      },
      logContext: {
        loginCodeRateLimitCount: 3,
        loginCodeRateLimitLimit: 2
      },
      retryAfterSeconds: 120
    });
  });

  it("fails closed when the durable login-code limit store is unavailable", async () => {
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
    const { checkLoginCodeRateLimit, LoginCodeRateLimitUnavailableError } =
      await importLoginCodeRateLimitModule({
        UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
        UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
      });

    await expect(
      checkLoginCodeRateLimit({
        "x-forwarded-for": "203.0.113.83"
      })
    ).rejects.toBeInstanceOf(LoginCodeRateLimitUnavailableError);
  });

  it("fails closed when the durable login-code expiry command fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              result: 1
            },
            {
              error: "expiry failed"
            },
            {
              result: -1
            }
          ]),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
      )
    );
    const { checkLoginCodeRateLimit, LoginCodeRateLimitUnavailableError } =
      await importLoginCodeRateLimitModule({
        UPSTASH_REDIS_REST_TOKEN: "test_upstash_token",
        UPSTASH_REDIS_REST_URL: "https://upstash.invalid"
      });

    await expect(
      checkLoginCodeRateLimit({
        "x-forwarded-for": "203.0.113.84"
      })
    ).rejects.toBeInstanceOf(LoginCodeRateLimitUnavailableError);
  });
});
