import { afterEach, describe, expect, it, vi } from "vitest";

const importRateLimitModule = async () => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    BILLING_QUOTA_IDENTITY_SECRET: "test_rate_limit_secret",
    RATE_LIMIT_MAX: "2",
    RATE_LIMIT_WINDOW_MS: "1000",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: ""
  })) {
    vi.stubEnv(key, value);
  }

  return import("./enforce-rate-limit.js");
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("in-memory rate limit bookkeeping", () => {
  it("evicts expired windows instead of growing forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { checkExtractRateLimit, getInMemoryRateLimitEntryCount } =
      await importRateLimitModule();

    for (let index = 0; index < 200; index += 1) {
      await checkExtractRateLimit({ "x-forwarded-for": `203.0.113.${index % 250}.${index}` });
    }

    expect(getInMemoryRateLimitEntryCount()).toBeGreaterThan(100);

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    await checkExtractRateLimit({ "x-forwarded-for": "198.51.100.7" });

    expect(getInMemoryRateLimitEntryCount()).toBe(1);
  });
});
