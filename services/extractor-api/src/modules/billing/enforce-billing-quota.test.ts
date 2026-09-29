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

  it("never keeps counting a hold whose request died, once it lapses", async () => {
    const { authorizeExtractionRequest, QUOTA_HOLD_TTL_MS } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "1"
    });
    const headers = { "x-linkdish-client-id": "crashed-user" };
    const address = identity("203.0.113.86");

    // Held, and never settled: the function timed out or the process died.
    const crashed = await authorizeExtractionRequest(headers, "primary", address);
    expect(crashed.allowed).toBe(true);
    expect((await authorizeExtractionRequest(headers, "primary", address)).allowed).toBe(false);

    const startedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startedAt + QUOTA_HOLD_TTL_MS + 1);

    const later = await authorizeExtractionRequest(headers, "primary", address);
    expect(later.allowed).toBe(true);
    const committed = await later.commitUsageWithQuota?.(success);
    expect(committed?.quota).toMatchObject({ limit: 1, remaining: 0 });
  });

  /** Upstash as a fetch double: `answer` decides each script's result (reads find nothing). */
  const stubUpstash = async (answer: (command: string[]) => Response | undefined) => {
    vi.resetModules();
    const scripts: string[][] = [];
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
        return Promise.resolve(answer(command) ?? new Response(JSON.stringify({ result: 1 })));
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
    const billing = await import("./enforce-billing.js");
    return { billing, scripts };
  };

  const named = (scripts: string[][], name: string) =>
    scripts.filter((command) => command[1]?.includes(name));
  /** A script's first ARGV (the reservation token), after its KEYS. */
  const tokenOf = (command: string[] | undefined) =>
    command ? command[3 + Number(command[2])] : undefined;

  it("holds through one Upstash script, and refuses when it reports a full allowance", async () => {
    const { billing, scripts } = await stubUpstash(
      () => new Response(JSON.stringify({ result: 0 }))
    );

    const authorization = await billing.authorizeExtractionRequest(
      { "x-linkdish-client-id": "upstash-user" },
      "primary",
      identity("203.0.113.84")
    );

    expect(authorization.allowed).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toEqual([
      "EVAL",
      expect.stringContaining("linkdish_reserve_quota_v3"),
      "2",
      expect.stringContaining(":lifetime:imports:"),
      expect.stringMatching(/:lifetime:imports:.*:pending$/u),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "1200",
      "1",
      "1",
      "3"
    ]);
  });

  it("commits a successful import's hold once, and lets a failed one's go", async () => {
    const { billing, scripts } = await stubUpstash(() => undefined);
    const headers = { "x-linkdish-client-id": "settle-user" };

    const imported = await billing.authorizeExtractionRequest(
      headers,
      "primary",
      identity("203.0.113.87")
    );
    await imported.commitUsage(success);
    await imported.commitUsage(success);
    const failed = await billing.authorizeExtractionRequest(
      headers,
      "primary",
      identity("203.0.113.87")
    );
    await failed.commitUsage(failure);

    const reserves = named(scripts, "linkdish_reserve_quota");
    expect(named(scripts, "linkdish_commit_quota").map(tokenOf)).toEqual([tokenOf(reserves[0])]);
    expect(named(scripts, "linkdish_release_quota").map(tokenOf)).toEqual([tokenOf(reserves[1])]);
  });

  it("tries a failed release again with the same reservation", async () => {
    let releaseFailures = 1;
    const { billing, scripts } = await stubUpstash((command) => {
      if (command[1]?.includes("linkdish_release_quota") && releaseFailures > 0) {
        releaseFailures -= 1;
        return new Response("Service Unavailable", { status: 503 });
      }

      return undefined;
    });

    const authorization = await billing.authorizeExtractionRequest(
      { "x-linkdish-client-id": "retry-user" },
      "primary",
      identity("203.0.113.85")
    );
    expect(authorization.allowed).toBe(true);
    await authorization.commitUsage(failure);
    await authorization.releaseUsage?.();

    const reserve = named(scripts, "linkdish_reserve_quota")[0];
    // The blip is retried; once a release goes through, the reservation is settled.
    expect(named(scripts, "linkdish_release_quota").map(tokenOf)).toEqual([
      tokenOf(reserve),
      tokenOf(reserve)
    ]);
  });

  it("returns a successful import even when its allowance can't be read afterwards", async () => {
    const { billing } = await stubUpstash(() => undefined);
    const authorization = await billing.authorizeExtractionRequest(
      { "x-linkdish-client-id": "read-failure-user" },
      "primary",
      identity("203.0.113.88")
    );
    vi.mocked(fetch).mockImplementation((_input, init) =>
      Promise.resolve(
        init?.body
          ? new Response(JSON.stringify({ result: 1 }))
          : new Response("Service Unavailable", { status: 503 })
      )
    );

    await expect(authorization.commitUsageWithQuota?.(success)).resolves.toMatchObject({
      quota: null
    });
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
