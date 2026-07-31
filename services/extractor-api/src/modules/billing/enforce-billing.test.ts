import { afterEach, describe, expect, it, vi } from "vitest";

const importBillingModule = async (env?: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    BILLING_ENFORCEMENT_ENABLED: "true",
    FREE_LIFETIME_IMPORT_LIMIT: "1",
    PLUS_MONTHLY_IMPORT_LIMIT: "2",
    FAMILY_MONTHLY_IMPORT_LIMIT: "4",
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

const stubRevenueCatEntitlement = (expiresDate: string | null | undefined) => {
  const entitlements =
    expiresDate === undefined
      ? {}
      : {
          Plus: {
            expires_date: expiresDate
          }
        };

  return stubRevenueCatEntitlements(entitlements);
};

const stubRevenueCatEntitlements = (
  entitlements: Record<string, { expires_date?: string | null }>
) => {
  const fetchMock = vi
    .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            subscriber: {
              entitlements
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
      )
    );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

const getLastConsoleCode = (infoSpy: ReturnType<typeof vi.spyOn>, prefix: string): string => {
  const message = [...infoSpy.mock.calls]
    .map(([entry]) => (typeof entry === "string" ? entry : ""))
    .reverse()
    .find((entry) => entry.startsWith(prefix));
  const code = message?.split(": ").at(-1)?.trim();

  if (!code) {
    throw new Error(`${prefix} code was not logged.`);
  }

  return code;
};

const createAuthenticatedUser = async (email: string, infoSpy: ReturnType<typeof vi.spyOn>) => {
  const auth = await import("../auth/auth-service.js");

  await auth.requestLoginCode(email);
  return auth.verifyLoginCode(email, getLastConsoleCode(infoSpy, "LinkDish login code for "));
};

const getLastInviteCode = (infoSpy: ReturnType<typeof vi.spyOn>): string =>
  getLastConsoleCode(infoSpy, "LinkDish household invite for ");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("authorizeExtractionRequest", () => {
  it("allows requests without a client id while billing enforcement is disabled", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      BILLING_ENFORCEMENT_ENABLED: "false"
    });

    const result = await authorizeExtractionRequest({}, "primary");

    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        billingEnabled: false,
        billingPlan: "disabled"
      }
    });
  });

  it("rejects enabled billing requests that do not include the app install client id", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();

    const result = await authorizeExtractionRequest({}, "primary");

    expect(result).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingClientId: null,
        billingEnabled: true,
        billingPlan: "unknown",
        quotaKind: "imports"
      }
    });
  });

  it("uses free import limits for unauthenticated requests", async () => {
    const fetchMock = stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const headers = {
      "x-forwarded-for": "203.0.113.10",
      "x-linkdish-client-id": "free-user"
    };

    const firstResult = await authorizeExtractionRequest(headers, "primary");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(headers, "primary");
    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("keeps free import metering lifetime-based while monthly metering is disabled", async () => {
    vi.useFakeTimers({
      now: new Date("2026-01-31T23:59:59.000Z")
    });
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const headers = {
      "x-forwarded-for": "203.0.113.11",
      "x-linkdish-client-id": "flag-off-free-user"
    };

    const firstResult = await authorizeExtractionRequest(headers, "primary");
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const secondResult = await authorizeExtractionRequest(headers, "primary");

    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit",
        quota: {
          limit: 1,
          remaining: 0,
          monthlyLimit: null,
          remainingThisMonth: null,
          resetsAt: null,
          meteringMode: "free_lifetime"
        }
      },
      logContext: {
        billingPlan: "free",
        meteringMode: "free_lifetime",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("resets free monthly metering at UTC month boundaries when enabled", async () => {
    vi.useFakeTimers({
      now: new Date("2026-01-31T23:59:59.000Z")
    });
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "0",
      FREE_MONTHLY_IMPORT_LIMIT: "2",
      LINKDISH_MONTHLY_METERING: "true"
    });

    const headers = {
      "x-forwarded-for": "203.0.113.12",
      "x-linkdish-client-id": "monthly-free-user"
    };

    const firstResult = await authorizeExtractionRequest(headers, "primary");
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(headers, "primary");
    await secondResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const blockedResult = await authorizeExtractionRequest(headers, "primary");

    expect(blockedResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit",
        quota: {
          limit: 2,
          remaining: 0,
          monthlyLimit: 2,
          remainingThisMonth: 0,
          resetsAt: "2026-02-01T00:00:00.000Z",
          meteringMode: "free_monthly_grandfathered"
        }
      },
      logContext: {
        billingPlan: "free",
        meteringMode: "free_monthly_grandfathered",
        quotaCount: 2,
        quotaLimit: 2
      }
    });

    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const rolloverResult = await authorizeExtractionRequest(headers, "primary");

    expect(rolloverResult).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        meteringMode: "free_monthly_grandfathered",
        quotaCount: 0,
        quotaLimit: 2
      }
    });
  });

  it("grandfathers free users with no total imports left into the monthly meter", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-15T12:00:00.000Z")
    });
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "3",
      FREE_MONTHLY_IMPORT_LIMIT: "5",
      LINKDISH_MONTHLY_METERING: "true"
    });

    const headers = {
      "x-forwarded-for": "203.0.113.13",
      "x-linkdish-client-id": "grandfather-empty-total-user"
    };

    for (let index = 0; index < 3; index += 1) {
      const result = await authorizeExtractionRequest(headers, "primary");
      await result.commitUsage({
        status: "success",
        recipe: {} as never,
        extraction: {} as never
      });
    }

    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    const monthlyResult = await authorizeExtractionRequest(headers, "primary");

    expect(monthlyResult).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        meteringMode: "free_monthly_grandfathered",
        quotaCount: 0,
        quotaLimit: 5
      }
    });
  });

  it("grandfathers free users with two total imports left to five available monthly imports", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-15T12:00:00.000Z")
    });
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule({
      FREE_LIFETIME_IMPORT_LIMIT: "3",
      FREE_MONTHLY_IMPORT_LIMIT: "5",
      LINKDISH_MONTHLY_METERING: "true"
    });

    const headers = {
      "x-forwarded-for": "203.0.113.14",
      "x-linkdish-client-id": "grandfather-two-left-user"
    };

    const previousMonthResult = await authorizeExtractionRequest(headers, "primary");
    await previousMonthResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });

    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const firstCurrentMonthResult = await authorizeExtractionRequest(headers, "primary");

    expect(firstCurrentMonthResult).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        meteringMode: "free_monthly_grandfathered",
        quotaCount: 0,
        quotaLimit: 5
      }
    });

    for (let index = 0; index < 5; index += 1) {
      const result =
        index === 0 ? firstCurrentMonthResult : await authorizeExtractionRequest(headers, "primary");
      expect(result.allowed).toBe(true);
      await result.commitUsage({
        status: "success",
        recipe: {} as never,
        extraction: {} as never
      });
    }

    const blockedResult = await authorizeExtractionRequest(headers, "primary");

    expect(blockedResult).toMatchObject({
      allowed: false,
      response: {
        quota: {
          limit: 5,
          remaining: 0,
          monthlyLimit: 5,
          remainingThisMonth: 0,
          resetsAt: "2026-08-01T00:00:00.000Z",
          meteringMode: "free_monthly_grandfathered"
        }
      },
      logContext: {
        quotaCount: 5,
        quotaLimit: 5
      }
    });
  });

  it("does not reset free quota when callers rotate client ids from the same network", async () => {
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const firstResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.20",
        "x-linkdish-client-id": "rotated-free-user-a"
      },
      "primary"
    );
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.20",
        "x-linkdish-client-id": "rotated-free-user-b"
      },
      "primary"
    );

    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingClientId: "rotated-free-user-b",
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("does not fall back to spoofable forwarding headers when explicit request identity is unknown", async () => {
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const firstResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.21",
        "x-linkdish-client-id": "unknown-identity-user-a"
      },
      "primary",
      {
        remoteAddress: "unknown"
      }
    );
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.22",
        "x-linkdish-client-id": "unknown-identity-user-b"
      },
      "primary",
      {
        remoteAddress: "unknown"
      }
    );

    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("uses trusted remote identity instead of rotated forwarding headers for free quota", async () => {
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const firstResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.23",
        "x-linkdish-client-id": "trusted-network-user-a"
      },
      "primary",
      {
        remoteAddress: "198.51.100.1"
      }
    );
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.24",
        "x-linkdish-client-id": "trusted-network-user-b"
      },
      "primary",
      {
        remoteAddress: "198.51.100.1"
      }
    );

    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("does not count failed imports against the import limit", async () => {
    stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const headers = {
      "x-forwarded-for": "203.0.113.30",
      "x-linkdish-client-id": "failed-import-user"
    };

    const failedImportResult = await authorizeExtractionRequest(headers, "primary");
    await failedImportResult.commitUsage({
      status: "failure",
      reason: "parse_failed",
      userMessage: "No recipe found."
    });
    const nextImportResult = await authorizeExtractionRequest(headers, "primary");

    expect(nextImportResult).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
  });

  it("does not trust unauthenticated client ids for paid entitlement lookup", async () => {
    const fetchMock = stubRevenueCatEntitlement("2099-01-01T00:00:00Z");
    const { authorizeExtractionRequest } = await importBillingModule();

    const headers = new Headers({
      "x-forwarded-for": "203.0.113.40",
      "x-linkdish-client-id": "plus-user"
    });

    const firstResult = await authorizeExtractionRequest(headers, "primary");
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(headers, "primary");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("uses Plus import limits for authenticated account ids", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchMock = stubRevenueCatEntitlement("2099-01-01T00:00:00Z");
    const { authorizeExtractionRequest } = await importBillingModule({
      AUTH_SECRET: "test_auth_secret",
      HOUSEHOLDS_ENABLED: "true",
      NODE_ENV: "test"
    });
    const session = await createAuthenticatedUser("plus-account@example.com", infoSpy);

    const firstResult = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${session.sessionToken}`,
        "x-forwarded-for": "203.0.113.41"
      },
      "primary"
    );
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${session.sessionToken}`,
        "x-forwarded-for": "203.0.113.41"
      },
      "primary"
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://api.revenuecat.com/v1/subscribers/${session.user.id}`
    );
    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        accountUserId: session.user.id,
        billingClientId: session.user.id,
        billingQuotaIdentity: "client",
        billingPlan: "plus",
        quotaCount: 0,
        quotaLimit: 2
      }
    });
    expect(secondResult).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "plus",
        quotaCount: 1,
        quotaLimit: 2
      }
    });
  });

  it("grants configured test premium plans only to authenticated account ids", async () => {
    const fetchMock = stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule({
      AUTH_SECRET: "test_auth_secret",
      HOUSEHOLDS_ENABLED: "true",
      LINKDISH_TEST_PREMIUM_PLAN_ID: "family",
      LINKDISH_TEST_PREMIUM_USER_IDS: "user_testpremium",
      NODE_ENV: "test"
    });
    const auth = await import("../auth/auth-service.js");
    const store = await import("../storage/upstash-store.js");
    const now = new Date().toISOString();
    const user = {
      createdAt: now,
      email: "test-premium@example.com",
      emailHash: auth.hashEmail("test-premium@example.com"),
      id: "user_testpremium",
      updatedAt: now
    };

    await store.setStoreString(auth.authKeys.user(user.id), JSON.stringify(user));
    const session = await auth.createSessionForUser(user);

    const result = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${session.sessionToken}`,
        "x-forwarded-for": "203.0.113.42"
      },
      "primary"
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        accountUserId: user.id,
        billingClientId: user.id,
        billingPlan: "family",
        billingQuotaIdentity: "client",
        quotaCount: 0,
        quotaLimit: 4
      }
    });
  });

  it("does not grant test premium plans to unauthenticated caller-controlled client ids", async () => {
    const fetchMock = stubRevenueCatEntitlement(undefined);
    const { authorizeExtractionRequest } = await importBillingModule({
      LINKDISH_TEST_PREMIUM_PLAN_ID: "family",
      LINKDISH_TEST_PREMIUM_USER_IDS: "user_testpremium"
    });

    const result = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.43",
        "x-linkdish-client-id": "user_testpremium"
      },
      "primary"
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        accountUserId: null,
        billingClientId: "user_testpremium",
        billingPlan: "free",
        billingQuotaIdentity: "network",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
  });

  it("does not grant unauthenticated Family limits from caller-controlled client ids", async () => {
    stubRevenueCatEntitlements({
      Family: {
        expires_date: "2099-01-01T00:00:00Z"
      }
    });
    const { authorizeExtractionRequest } = await importBillingModule();

    const headers = new Headers({
      "x-forwarded-for": "203.0.113.45",
      "x-linkdish-client-id": "family-user"
    });

    const firstResult = await authorizeExtractionRequest(headers, "primary");
    await firstResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondResult = await authorizeExtractionRequest(headers, "primary");

    expect(firstResult).toMatchObject({
      allowed: true,
      logContext: {
        billingQuotaIdentity: "network",
        billingPlan: "free",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    expect(secondResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingPlan: "free",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("shares Family quota across authenticated household owner and members", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    stubRevenueCatEntitlements({
      Family: {
        expires_date: "2099-01-01T00:00:00Z"
      }
    });
    const { authorizeExtractionRequest } = await importBillingModule({
      AUTH_SECRET: "test_auth_secret",
      FAMILY_MONTHLY_IMPORT_LIMIT: "1",
      HOUSEHOLDS_ENABLED: "true",
      NODE_ENV: "test"
    });
    const households = await import("../households/household-service.js");
    const ownerSession = await createAuthenticatedUser("owner@example.com", infoSpy);
    const memberSession = await createAuthenticatedUser("member@example.com", infoSpy);

    await households.createHouseholdForOwner(ownerSession.user);
    await households.createHouseholdInvite(ownerSession.user, memberSession.user.email);
    await households.acceptHouseholdInvite(memberSession.user, getLastInviteCode(infoSpy));

    const ownerResult = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${ownerSession.sessionToken}`
      },
      "primary"
    );
    await ownerResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const memberResult = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${memberSession.sessionToken}`
      },
      "primary"
    );

    expect(ownerResult).toMatchObject({
      allowed: true,
      logContext: {
        accountUserId: ownerSession.user.id,
        billingPlan: "family",
        billingQuotaIdentity: "household",
        householdRole: "owner",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    expect(memberResult).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        accountUserId: memberSession.user.id,
        billingPlan: "family",
        billingQuotaIdentity: "household",
        householdRole: "member",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("does not grant member household quota when the owner loses Family entitlement", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let familyActive = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              subscriber: {
                entitlements: familyActive
                  ? {
                      Family: {
                        expires_date: "2099-01-01T00:00:00Z"
                      }
                    }
                  : {}
              }
            }),
            {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            }
          )
        )
      )
    );
    const { authorizeExtractionRequest } = await importBillingModule({
      AUTH_SECRET: "test_auth_secret",
      HOUSEHOLDS_ENABLED: "true",
      NODE_ENV: "test"
    });
    const households = await import("../households/household-service.js");
    const ownerSession = await createAuthenticatedUser("owner-loss@example.com", infoSpy);
    const memberSession = await createAuthenticatedUser("member-loss@example.com", infoSpy);

    await households.createHouseholdForOwner(ownerSession.user);
    await households.createHouseholdInvite(ownerSession.user, memberSession.user.email);
    await households.acceptHouseholdInvite(memberSession.user, getLastInviteCode(infoSpy));

    familyActive = false;
    const memberResult = await authorizeExtractionRequest(
      {
        authorization: `Bearer ${memberSession.sessionToken}`,
        "x-forwarded-for": "203.0.113.80"
      },
      "primary"
    );

    expect(memberResult).toMatchObject({
      allowed: true,
      logContext: {
        accountUserId: memberSession.user.id,
        billingPlan: "free",
        billingQuotaIdentity: "network",
        householdId: null,
        householdRole: null
      }
    });
  });

  it("uses free limits for unauthenticated requests even when paid entitlements exist", async () => {
    stubRevenueCatEntitlements({
      Plus: {
        expires_date: "2099-01-01T00:00:00Z"
      },
      Family: {
        expires_date: "2099-01-01T00:00:00Z"
      }
    });
    const { authorizeExtractionRequest } = await importBillingModule();

    const result = await authorizeExtractionRequest(
      {
        "x-forwarded-for": "203.0.113.46",
        "x-linkdish-client-id": "paid-both-user"
      },
      "primary"
    );

    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        quotaLimit: 1
      }
    });
  });

  it("keeps fallback extraction quota aligned with the import quota for free plans", async () => {
    stubRevenueCatEntitlement("2099-01-01T00:00:00Z");
    const { authorizeExtractionRequest } = await importBillingModule({
      PLUS_MONTHLY_IMPORT_LIMIT: "2"
    });

    const headers = {
      "x-forwarded-for": "203.0.113.50",
      "x-linkdish-client-id": "plus-fallback-user"
    };

    const importResult = await authorizeExtractionRequest(headers, "primary");
    await importResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const fallbackResult = await authorizeExtractionRequest(headers, "fallback");
    await fallbackResult.commitUsage({
      status: "success",
      recipe: {} as never,
      extraction: {} as never
    });
    const secondFallbackResult = await authorizeExtractionRequest(headers, "fallback");

    expect(importResult).toMatchObject({
      allowed: true,
      logContext: {
        quotaKind: "imports",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    expect(fallbackResult).toMatchObject({
      allowed: false,
      logContext: {
        quotaKind: "imports",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
    expect(secondFallbackResult).toMatchObject({
      allowed: false,
      logContext: {
        quotaKind: "imports",
        quotaCount: 1,
        quotaLimit: 1
      }
    });
  });

  it("does not depend on RevenueCat availability for unauthenticated requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "temporary outage" }), {
          status: 503,
          headers: {
            "content-type": "application/json"
          }
        })
      )
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { authorizeExtractionRequest } = await importBillingModule();

    const result = await authorizeExtractionRequest(
      {
        "x-linkdish-client-id": "revenuecat-outage-user"
      },
      "primary"
    );

    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        billingPlan: "free",
        quotaCount: 0,
        quotaLimit: 1
      }
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("allows canary requests that present the configured canary token", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      LINKDISH_CANARY_TOKEN: "canary-secret-token"
    });

    const result = await authorizeExtractionRequest(
      {
        authorization: "Bearer canary-secret-token"
      },
      "primary"
    );

    expect(result).toMatchObject({
      allowed: true,
      logContext: {
        billingClientId: "live-canary",
        billingEnabled: true,
        billingPlan: "plus",
        meteringMode: "disabled",
        quotaKind: "imports"
      }
    });
  });

  it("enforces billing normally when the canary token does not match", async () => {
    const { authorizeExtractionRequest } = await importBillingModule({
      LINKDISH_CANARY_TOKEN: "canary-secret-token"
    });

    const result = await authorizeExtractionRequest(
      {
        authorization: "Bearer wrong-token"
      },
      "primary"
    );

    expect(result).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingClientId: null
      }
    });
  });

  it("enforces billing normally when no canary token is configured", async () => {
    const { authorizeExtractionRequest } = await importBillingModule();

    const result = await authorizeExtractionRequest(
      {
        authorization: "Bearer canary-secret-token"
      },
      "primary"
    );

    expect(result).toMatchObject({
      allowed: false,
      response: {
        status: "failure",
        reason: "plan_limit"
      },
      logContext: {
        billingClientId: null
      }
    });
  });
});
