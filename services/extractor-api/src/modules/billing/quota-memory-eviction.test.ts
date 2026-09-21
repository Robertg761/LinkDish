import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractRecipeResponse } from "../../../../../packages/api-contracts/src/index.js";

const successResponse = {
  status: "success"
} as unknown as ExtractRecipeResponse;

const importBillingModule = async () => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    BILLING_ENFORCEMENT_ENABLED: "true",
    BILLING_QUOTA_IDENTITY_SECRET: "test_quota_secret",
    FREE_LIFETIME_IMPORT_LIMIT: "3",
    FREE_MONTHLY_IMPORT_LIMIT: "5",
    HOUSEHOLDS_ENABLED: "false",
    LINKDISH_MONTHLY_METERING: "true",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: ""
  })) {
    vi.stubEnv(key, value);
  }

  return import("./enforce-billing.js");
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("in-memory quota bookkeeping", () => {
  it("releases stale monthly counters instead of growing forever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));

    const { authorizeExtractionRequest, getInMemoryQuotaEntryCount } = await importBillingModule();

    for (let index = 0; index < 120; index += 1) {
      const authorization = await authorizeExtractionRequest(
        {
          "x-forwarded-for": `203.0.113.${index % 200}`,
          "x-linkdish-client-id": `client-${index}`
        },
        "primary"
      );

      expect(authorization.allowed).toBe(true);
      await authorization.commitUsage(successResponse);
    }

    const grownCount = getInMemoryQuotaEntryCount();

    expect(grownCount).toBeGreaterThanOrEqual(100);

    /* Two months later every monthly counter is stale and must be released. */
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    const authorization = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "198.51.100.9",
        "x-linkdish-client-id": "client-final"
      },
      "primary"
    );
    await authorization.commitUsage(successResponse);

    expect(getInMemoryQuotaEntryCount()).toBeLessThan(grownCount);
  });
});
