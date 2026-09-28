import { afterEach, describe, expect, it, vi } from "vitest";

const importBillingModule = async (env?: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    BILLING_ENFORCEMENT_ENABLED: "true",
    FREE_LIFETIME_IMPORT_LIMIT: "3",
    PLUS_MONTHLY_IMPORT_LIMIT: "5",
    FAMILY_MONTHLY_IMPORT_LIMIT: "8",
    REVENUECAT_ENTITLEMENT_ID: "Plus",
    REVENUECAT_FAMILY_ENTITLEMENT_ID: "Family",
    REVENUECAT_SECRET_API_KEY: "test_revenuecat_secret",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

  return import("./enforce-billing.js");
};

const success = {
  status: "success",
  recipe: {} as never,
  extraction: {} as never
} as const;

const identity = (remoteAddress: string) => ({ remoteAddress });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("committed quota", () => {
  it("returns the allowance left after a successful import", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();
    const headers = { "x-linkdish-client-id": "quota-user" };

    const authorization = await authorizeExtractionRequest(
      headers,
      "primary",
      identity("203.0.113.70")
    );
    const committed = await authorization.commitUsageWithQuota?.(success);

    expect(committed?.quota).toMatchObject({
      limit: 3,
      remaining: 2,
      monthlyLimit: null,
      meteringMode: "free_lifetime"
    });
    expect(committed?.logContext).toMatchObject({ quotaCount: 1, quotaLimit: 3 });
  });

  it("reports the allowance that runs out first for fallback imports", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();
    const headers = { "x-linkdish-client-id": "fallback-quota-user" };
    const address = identity("203.0.113.71");

    await (await authorizeExtractionRequest(headers, "primary", address)).commitUsage(success);
    const fallback = await authorizeExtractionRequest(headers, "fallback", address);
    const committed = await fallback.commitUsageWithQuota?.(success);

    // imports: 2 used of 3; strong extractions: 1 used of 3. The import allowance binds.
    expect(committed?.quota?.remaining).toBe(1);
  });

  it("does not count or report quota for failed imports", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();
    const headers = { "x-linkdish-client-id": "failed-quota-user" };
    const address = identity("203.0.113.72");

    const authorization = await authorizeExtractionRequest(headers, "primary", address);
    const committed = await authorization.commitUsageWithQuota?.({
      status: "failure",
      reason: "parse_failed",
      userMessage: "No recipe."
    });
    const next = await authorizeExtractionRequest(headers, "primary", address);

    expect(committed?.quota).toBeNull();
    expect(next.logContext.quotaCount).toBe(0);
  });

  it("keeps commitUsage returning the same log context as before", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();
    const authorization = await authorizeExtractionRequest(
      { "x-linkdish-client-id": "legacy-commit-user" },
      "primary",
      identity("203.0.113.73")
    );

    await expect(authorization.commitUsage(success)).resolves.toMatchObject({
      billingPlan: "free",
      quotaCount: 1,
      quotaLimit: 3
    });
  });

  it("reports no quota when billing enforcement is disabled", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      BILLING_ENFORCEMENT_ENABLED: "false"
    });
    const authorization = await authorizeExtractionRequest({}, "primary");

    expect(authorization.commitUsageWithQuota).toBeUndefined();
  });
});

describe("readBillingUsage", () => {
  it("reads the current allowance without counting an import", async () => {
    const { authorizeExtractionRequest, readBillingUsage } = await importBillingModule();
    const headers = { "x-linkdish-client-id": "usage-user" };
    const address = identity("203.0.113.80");

    await expect(readBillingUsage(headers, address)).resolves.toMatchObject({
      billingEnabled: true,
      plan: "free",
      quota: { limit: 3, remaining: 3 }
    });

    await (await authorizeExtractionRequest(headers, "primary", address)).commitUsage(success);

    await expect(readBillingUsage(headers, address)).resolves.toMatchObject({
      quota: { remaining: 2 }
    });
    await expect(readBillingUsage(headers, address)).resolves.toMatchObject({
      quota: { remaining: 2 }
    });
  });

  it("returns no quota when billing is off or the install is unknown", async () => {
    const disabled = await importBillingModule({ BILLING_ENFORCEMENT_ENABLED: "false" });

    await expect(disabled.readBillingUsage({})).resolves.toEqual({
      billingEnabled: false,
      plan: null,
      quota: null
    });

    const enabled = await importBillingModule();

    await expect(enabled.readBillingUsage({}, identity("203.0.113.81"))).resolves.toEqual({
      billingEnabled: true,
      plan: null,
      quota: null
    });
  });
});
