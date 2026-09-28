import { afterEach, describe, expect, it, vi } from "vitest";

const importEntitlements = async (env: Record<string, string> = {}) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    REVENUECAT_FAMILY_ENTITLEMENT_ID: "Family",
    REVENUECAT_PLUS_ENTITLEMENT_ID: "Plus",
    REVENUECAT_SECRET_API_KEY: "test_revenuecat_secret",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.invalid",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  return import("./revenuecat-entitlements.js");
};

/* RevenueCat answers with whatever `plans` currently holds for each app user id. */
const stubRevenueCat = (plans: Map<string, "plus" | "family" | "free">) => {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const appUserId = decodeURIComponent(new URL(rawUrl).pathname.split("/").at(-1) ?? "");
    const plan = plans.get(appUserId) ?? "free";

    return Promise.resolve(
      new Response(
        JSON.stringify({
          subscriber: {
            entitlements:
              plan === "free"
                ? {}
                : { [plan === "family" ? "Family" : "Plus"]: { expires_date: null } }
          }
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      )
    );
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("RevenueCat entitlement cache", () => {
  it("caches paid plans for hot-path lookups", async () => {
    const plans = new Map([["user_plus", "plus" as const]]);
    const fetchMock = stubRevenueCat(plans);
    const entitlements = await importEntitlements();

    await expect(entitlements.getCachedRevenueCatBillingPlanId("user_plus")).resolves.toBe("plus");
    await expect(entitlements.getCachedRevenueCatBillingPlanId("user_plus")).resolves.toBe("plus");
    await expect(entitlements.peekCachedRevenueCatBillingPlanId("user_plus")).resolves.toBe("plus");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never caches the free plan, so a purchase is seen on the next request", async () => {
    const plans = new Map<string, "plus" | "family" | "free">([["user_new", "free"]]);
    const fetchMock = stubRevenueCat(plans);
    const entitlements = await importEntitlements();

    await expect(entitlements.getCachedRevenueCatBillingPlanId("user_new")).resolves.toBe("free");
    plans.set("user_new", "plus");
    await expect(entitlements.getCachedRevenueCatBillingPlanId("user_new")).resolves.toBe("plus");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops cached plans on invalidation and on a fresh lookup that finds none", async () => {
    const plans = new Map<string, "plus" | "family" | "free">([["user_family", "family"]]);
    const fetchMock = stubRevenueCat(plans);
    const entitlements = await importEntitlements();

    await expect(entitlements.hasActiveRevenueCatFamilyEntitlement("user_family")).resolves.toBe(
      true
    );
    plans.set("user_family", "free");
    await expect(entitlements.hasActiveRevenueCatFamilyEntitlement("user_family")).resolves.toBe(
      true
    );

    await entitlements.invalidateRevenueCatEntitlementCache("user_family", null, "");
    await expect(entitlements.hasActiveRevenueCatFamilyEntitlement("user_family")).resolves.toBe(
      false
    );

    plans.set("user_family", "family");
    await entitlements.getCachedRevenueCatBillingPlanId("user_family");
    plans.set("user_family", "free");
    await expect(entitlements.verifyActiveRevenueCatFamilyEntitlement("user_family")).resolves.toBe(
      false
    );
    await expect(entitlements.peekCachedRevenueCatBillingPlanId("user_family")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not let a lookup that started before an invalidation re-cache its stale plan", async () => {
    const releases: Array<(response: Response) => void> = [];
    const familyResponse = () =>
      new Response(
        JSON.stringify({ subscriber: { entitlements: { Family: { expires_date: null } } } }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const entitlements = await importEntitlements();

    /* An import asks RevenueCat, which still answers with the pre-refund state... */
    const lookup = entitlements.getRevenueCatBillingPlanId("user_refunded");
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    /* ...the refund webhook drops the cache while that answer is on its way... */
    await entitlements.invalidateRevenueCatEntitlementCache("user_refunded");
    releases[0]?.(familyResponse());

    /* ...and the stale answer must not be cached as if it were current. */
    await expect(lookup).resolves.toBe("family");
    await expect(
      entitlements.peekCachedRevenueCatBillingPlanId("user_refunded")
    ).resolves.toBeNull();

    const recheck = entitlements.hasActiveRevenueCatFamilyEntitlement("user_refunded");
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    releases[1]?.(new Response(JSON.stringify({ subscriber: { entitlements: {} } })));
    await expect(recheck).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a plan from a lookup that outlived the invalidation window", async () => {
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    const entitlements = await importEntitlements();
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now");

    const lookup = entitlements.getRevenueCatBillingPlanId("user_slow");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    now.mockReturnValue(
      startedAt + entitlements.REVENUECAT_ENTITLEMENT_CACHE_TTL_SECONDS * 1_000 + 1_000
    );
    release(
      new Response(
        JSON.stringify({ subscriber: { entitlements: { Plus: { expires_date: null } } } })
      )
    );

    await expect(lookup).resolves.toBe("plus");
    await expect(entitlements.peekCachedRevenueCatBillingPlanId("user_slow")).resolves.toBeNull();
    now.mockRestore();
  });

  it("shares one RevenueCat call between concurrent lookups for the same user", async () => {
    const fetchMock = stubRevenueCat(new Map([["user_busy", "family" as const]]));
    const entitlements = await importEntitlements();

    await Promise.all([
      entitlements.getRevenueCatBillingPlanId("user_busy"),
      entitlements.getCachedRevenueCatBillingPlanId("user_busy"),
      entitlements.hasActiveRevenueCatFamilyEntitlement("user_busy")
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys the cache by a hashed user id and answers test premium users without RevenueCat", async () => {
    const fetchMock = stubRevenueCat(new Map());
    const entitlements = await importEntitlements({
      LINKDISH_TEST_PREMIUM_PLAN_ID: "family",
      LINKDISH_TEST_PREMIUM_USER_IDS: "user_tester"
    });

    expect(entitlements.getRevenueCatEntitlementCacheKey("user_tester")).toMatch(
      /^linkdish:entitlement:v1:[0-9a-f]{32}$/
    );
    await expect(entitlements.peekCachedRevenueCatBillingPlanId("user_tester")).resolves.toBe(
      "family"
    );
    await expect(entitlements.hasActiveRevenueCatFamilyEntitlement("user_tester")).resolves.toBe(
      true
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
