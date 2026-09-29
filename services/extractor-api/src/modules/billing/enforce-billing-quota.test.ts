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

describe("reserved quota", () => {
  const failure = {
    status: "failure",
    reason: "parse_failed",
    userMessage: "No recipe."
  } as const;

  it("admits only one of two parallel imports when one is left", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "1"
    });
    const headers = { "x-linkdish-client-id": "parallel-user" };
    const address = identity("203.0.113.80");

    const [first, second] = await Promise.all([
      authorizeExtractionRequest(headers, "primary", address),
      authorizeExtractionRequest(headers, "primary", address)
    ]);

    expect([first.allowed, second.allowed].sort()).toEqual([false, true]);
    const refused = first.allowed ? second : first;
    expect(refused.response).toMatchObject({ reason: "plan_limit", status: "failure" });
  });

  it("counts a successful import once, and refuses the next one past the limit", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "1"
    });
    const headers = { "x-linkdish-client-id": "success-user" };
    const address = identity("203.0.113.81");

    const authorization = await authorizeExtractionRequest(headers, "primary", address);
    const committed = await authorization.commitUsageWithQuota?.(success);
    const next = await authorizeExtractionRequest(headers, "primary", address);

    expect(committed?.quota).toMatchObject({ limit: 1, remaining: 0 });
    expect(next.allowed).toBe(false);
  });

  it("gives the allowance back when the import fails or never finishes", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "1"
    });
    const headers = { "x-linkdish-client-id": "returned-user" };
    const address = identity("203.0.113.82");

    const failed = await authorizeExtractionRequest(headers, "primary", address);
    await failed.commitUsage(failure);
    const threw = await authorizeExtractionRequest(headers, "primary", address);
    expect(threw.allowed).toBe(true);
    await threw.releaseUsage?.();
    // Settled once: a second release (or a commit after it) gives nothing more back.
    await threw.releaseUsage?.();
    await threw.commitUsage(failure);

    const [next, parallel] = await Promise.all([
      authorizeExtractionRequest(headers, "primary", address),
      authorizeExtractionRequest(headers, "primary", address)
    ]);
    expect([next.allowed, parallel.allowed].sort()).toEqual([false, true]);
  });

  it("reserves every allowance a fallback import needs, or none of them", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "1"
    });
    const headers = { "x-linkdish-client-id": "fallback-user" };
    const address = identity("203.0.113.83");

    const primary = await authorizeExtractionRequest(headers, "primary", address);
    await primary.commitUsage(success);
    // The import allowance is spent: the fallback is refused and takes no strong extraction.
    const fallback = await authorizeExtractionRequest(headers, "fallback", address);
    expect(fallback.allowed).toBe(false);
  });

  it("reserves through one Upstash script, and refuses when it reports a full allowance", async () => {
    vi.resetModules();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: { body?: string }) => {
        if (init?.body) {
          bodies.push(JSON.parse(init.body));
          return Promise.resolve(new Response(JSON.stringify({ result: 0 })));
        }

        return Promise.resolve(
          new Response(JSON.stringify({ result: input.includes("/get/") ? "0" : null }))
        );
      })
    );
    for (const [key, value] of Object.entries({
      BILLING_ENFORCEMENT_ENABLED: "true",
      FREE_LIFETIME_IMPORT_LIMIT: "3",
      UPSTASH_REDIS_REST_TOKEN: "token",
      UPSTASH_REDIS_REST_URL: "https://upstash.test"
    })) {
      vi.stubEnv(key, value);
    }
    const { authorizeExtractionRequest } = await import("./enforce-billing.js");

    const authorization = await authorizeExtractionRequest(
      { "x-linkdish-client-id": "upstash-user" },
      "primary",
      identity("203.0.113.84")
    );

    expect(authorization.allowed).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual([
      "EVAL",
      expect.stringContaining("linkdish_reserve_quota_v2"),
      "2",
      expect.stringContaining("linkdish:quota-reservation:"),
      expect.stringContaining(":lifetime:imports:"),
      "3600",
      "1",
      "1",
      "3",
      "0"
    ]);
  });

  it("tries a failed release again with the same reservation, so it goes back once", async () => {
    vi.resetModules();
    const scripts: string[][] = [];
    let releaseFailures = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: { body?: string }) => {
        if (!init?.body) {
          return Promise.resolve(
            new Response(JSON.stringify({ result: input.includes("/get/") ? "0" : null }))
          );
        }

        const command = JSON.parse(init.body) as string[];
        scripts.push(command);

        if (command[1]?.includes("linkdish_release_quota") && releaseFailures > 0) {
          releaseFailures -= 1;
          return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
        }

        return Promise.resolve(new Response(JSON.stringify({ result: 1 })));
      })
    );
    for (const [key, value] of Object.entries({
      BILLING_ENFORCEMENT_ENABLED: "true",
      FREE_LIFETIME_IMPORT_LIMIT: "3",
      UPSTASH_REDIS_REST_TOKEN: "token",
      UPSTASH_REDIS_REST_URL: "https://upstash.test"
    })) {
      vi.stubEnv(key, value);
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { authorizeExtractionRequest } = await import("./enforce-billing.js");

    const authorization = await authorizeExtractionRequest(
      { "x-linkdish-client-id": "retry-user" },
      "primary",
      identity("203.0.113.85")
    );
    expect(authorization.allowed).toBe(true);
    await authorization.commitUsage(failure);
    await authorization.releaseUsage?.();

    const reserve = scripts.find((command) => command[1]?.includes("linkdish_reserve_quota"));
    const releases = scripts.filter((command) => command[1]?.includes("linkdish_release_quota"));
    // The blip is retried; once a release goes through, nothing more is given back.
    expect(releases).toHaveLength(2);
    expect(releases.map((command) => command[3])).toEqual([reserve?.[3], reserve?.[3]]);
    expect(reserve?.[3]).toContain("linkdish:quota-reservation:");
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
