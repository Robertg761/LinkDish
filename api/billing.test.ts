import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BillingModule from "./billing.js";

type BillingApi = typeof BillingModule;

let billingApi: BillingApi;

const getRequestUrl = (input: RequestInfo | URL | undefined): string => {
  if (!input) {
    return "";
  }

  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
};

const setVerifiedClerkSession = async () => {
  const { setClerkAuthVerifierForTesting } =
    await import("../services/extractor-api/src/modules/auth/clerk-auth-service.js");

  setClerkAuthVerifierForTesting({
    getExternalIdentity(subject) {
      return Promise.resolve({
        email: "web-billing@example.com",
        emailVerified: true,
        subject
      });
    },
    verifySessionToken() {
      return Promise.resolve({
        expiresAt: "2026-06-01T00:00:00.000Z",
        subject: "clerk_web_billing"
      });
    }
  });
};

const reloadBillingApi = async (): Promise<BillingApi> => {
  vi.resetModules();
  await setVerifiedClerkSession();
  billingApi = await import("./billing.js");

  return billingApi;
};

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "clerk_beta");
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("AUTH_SESSION_TTL_SECONDS", "7776000");
  vi.stubEnv("HOUSEHOLDS_ENABLED", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("REVENUECAT_PROJECT_ID", "proj15a7ba10");
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "");
  vi.stubEnv("REVENUECAT_V2_SECRET_API_KEY", "");
  vi.stubEnv("REVENUECAT_WEB_MANAGEMENT_URL", "https://pay.rev.cat/manage/{app_user_id}");
  vi.stubEnv("REVENUECAT_WEB_PURCHASE_LINK_PLUS_MONTHLY", "https://pay.rev.cat/plus-monthly");
  vi.stubEnv("WEB_BILLING_CHECKOUT_ENABLED", "true");
  await reloadBillingApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel billing adapter", () => {
  it("reports configured web checkout availability", async () => {
    const response = billingApi.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      managementPortalAvailable: true,
      plans: {
        family: {
          monthly: false,
          yearly: false
        },
        plus: {
          monthly: true,
          yearly: false
        }
      },
      prices: {
        family: {
          monthly: "$4.99/month",
          yearly: "$44.99/year"
        },
        plus: {
          monthly: "$2.99/month",
          yearly: "$24.99/year"
        }
      },
      webCheckoutEnabled: true
    });
  });

  it("omits the founding offer until its Web Purchase Link is configured", async () => {
    const response = billingApi.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("founding");
  });

  it("reports the founding lifetime offer when its Web Purchase Link is configured", async () => {
    vi.stubEnv(
      "REVENUECAT_WEB_PURCHASE_LINK_FOUNDING_LIFETIME",
      "https://pay.rev.cat/founding-lifetime"
    );
    vi.stubEnv("FOUNDING_LIFETIME_PRICE_LABEL", "$19.99");
    const api = await reloadBillingApi();

    const response = api.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      founding: {
        available: true,
        priceLabel: "$19.99"
      }
    });
  });

  it("hides the founding offer when web checkout is disabled", async () => {
    vi.stubEnv("WEB_BILLING_CHECKOUT_ENABLED", "false");
    vi.stubEnv(
      "REVENUECAT_WEB_PURCHASE_LINK_FOUNDING_LIFETIME",
      "https://pay.rev.cat/founding-lifetime"
    );
    const api = await reloadBillingApi();

    const response = api.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      founding: {
        available: false,
        priceLabel: "$29.99"
      },
      webCheckoutEnabled: false
    });
  });

  it("creates an identified founding lifetime checkout URL", async () => {
    vi.stubEnv(
      "REVENUECAT_WEB_PURCHASE_LINK_FOUNDING_LIFETIME",
      "https://pay.rev.cat/founding-lifetime"
    );
    const api = await reloadBillingApi();

    const response = await api.POST(
      new Request("https://api.linkdish.ca/api/billing?path=checkout", {
        body: JSON.stringify({
          offer: "founding"
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const checkoutUrl = new URL(body.url);

    expect(checkoutUrl.origin).toBe("https://pay.rev.cat");
    expect(checkoutUrl.pathname).toMatch(/^\/founding-lifetime\/user_[A-Za-z0-9_-]+$/u);
    expect(checkoutUrl.searchParams.get("email")).toBe("web-billing@example.com");
  });

  it("rejects a founding checkout when its Web Purchase Link is not configured", async () => {
    const response = await billingApi.POST(
      new Request("https://api.linkdish.ca/api/billing?path=checkout", {
        body: JSON.stringify({
          offer: "founding"
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      message: "This web checkout option is not configured yet."
    });
  });

  it("reports every plan/period available when all Web Purchase Links are configured", async () => {
    vi.stubEnv("REVENUECAT_WEB_PURCHASE_LINK_PLUS_YEARLY", "https://pay.rev.cat/plus-yearly");
    vi.stubEnv("REVENUECAT_WEB_PURCHASE_LINK_FAMILY_MONTHLY", "https://pay.rev.cat/family-monthly");
    vi.stubEnv("REVENUECAT_WEB_PURCHASE_LINK_FAMILY_YEARLY", "https://pay.rev.cat/family-yearly");
    const api = await reloadBillingApi();

    const response = api.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      plans: {
        family: {
          monthly: true,
          yearly: true
        },
        plus: {
          monthly: true,
          yearly: true
        }
      },
      webCheckoutEnabled: true
    });
  });

  it("creates an identified RevenueCat web checkout URL for the Family yearly plan", async () => {
    vi.stubEnv("REVENUECAT_WEB_PURCHASE_LINK_FAMILY_YEARLY", "https://pay.rev.cat/family-yearly");
    const api = await reloadBillingApi();

    const response = await api.POST(
      new Request("https://api.linkdish.ca/api/billing?path=checkout", {
        body: JSON.stringify({
          period: "yearly",
          plan: "family"
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const checkoutUrl = new URL(body.url);

    expect(checkoutUrl.origin).toBe("https://pay.rev.cat");
    expect(checkoutUrl.pathname).toMatch(/^\/family-yearly\/user_[A-Za-z0-9_-]+$/u);
    expect(checkoutUrl.searchParams.get("email")).toBe("web-billing@example.com");
  });

  it("reports the management portal as available when RevenueCat v2 portal access is configured", async () => {
    vi.stubEnv("REVENUECAT_WEB_MANAGEMENT_URL", "");
    vi.stubEnv("REVENUECAT_V2_SECRET_API_KEY", "rc_v2_test");
    const api = await reloadBillingApi();

    const response = api.GET(new Request("https://api.linkdish.ca/api/billing?path=config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      managementPortalAvailable: true
    });
  });

  it("requires sign-in before creating checkout links", async () => {
    const response = await billingApi.POST(
      new Request("https://api.linkdish.ca/api/billing?path=checkout", {
        body: JSON.stringify({
          period: "monthly",
          plan: "plus"
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Sign in is required before managing billing."
    });
  });

  it("creates an identified RevenueCat web checkout URL for authenticated users", async () => {
    const response = await billingApi.POST(
      new Request("https://api.linkdish.ca/api/billing?path=checkout", {
        body: JSON.stringify({
          period: "monthly",
          plan: "plus"
        }),
        headers: {
          authorization: "Bearer header.payload.signature",
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const checkoutUrl = new URL(body.url);

    expect(checkoutUrl.origin).toBe("https://pay.rev.cat");
    expect(checkoutUrl.pathname).toMatch(/^\/plus-monthly\/user_[A-Za-z0-9_-]+$/u);
    expect(checkoutUrl.pathname).not.toContain("clerk_web_billing");
    expect(checkoutUrl.searchParams.get("email")).toBe("web-billing@example.com");
  });

  it("creates an authenticated RevenueCat customer portal URL for web subscriptions", async () => {
    vi.stubEnv("REVENUECAT_WEB_MANAGEMENT_URL", "");
    vi.stubEnv("REVENUECAT_V2_SECRET_API_KEY", "rc_v2_test");
    const api = await reloadBillingApi();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void init;
      const requestUrl = getRequestUrl(input);

      if (requestUrl.includes("/customers/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  environment: "production",
                  gives_access: true,
                  id: "sub_google",
                  status: "active",
                  store: "play_store"
                },
                {
                  environment: "production",
                  gives_access: true,
                  id: "sub_web",
                  status: "active",
                  store: "rc_billing"
                }
              ],
              object: "list"
            }),
            {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            }
          )
        );
      }

      if (requestUrl.endsWith("/subscriptions/sub_web/authenticated_management_url")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              management_url: "https://billing.revenuecat.com/session/test_customer_portal",
              object: "authenticated_management_url"
            }),
            {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            }
          )
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ message: "not found" }), { status: 404 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await api.POST(
      new Request("https://api.linkdish.ca/api/billing?path=portal", {
        headers: {
          authorization: "Bearer header.payload.signature"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://billing.revenuecat.com/session/test_customer_portal"
    });

    const customerUrl = getRequestUrl(fetchMock.mock.calls[0]?.[0]);
    const managementUrl = getRequestUrl(fetchMock.mock.calls[1]?.[0]);

    expect(customerUrl).toMatch(
      /^https:\/\/api\.revenuecat\.com\/v2\/projects\/proj15a7ba10\/customers\/user_[A-Za-z0-9_-]+\/subscriptions\?environment=production&limit=100$/u
    );
    expect(managementUrl).toBe(
      "https://api.revenuecat.com/v2/projects/proj15a7ba10/subscriptions/sub_web/authenticated_management_url"
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        authorization: "Bearer rc_v2_test"
      }
    });
  });

  it("follows paginated RevenueCat customer subscriptions before creating a portal URL", async () => {
    vi.stubEnv("REVENUECAT_WEB_MANAGEMENT_URL", "");
    vi.stubEnv("REVENUECAT_V2_SECRET_API_KEY", "rc_v2_test");
    const api = await reloadBillingApi();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      void init;
      const requestUrl = getRequestUrl(input);

      if (requestUrl.includes("starting_after=sub_expired")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  environment: "production",
                  gives_access: true,
                  id: "sub_web",
                  status: "active",
                  store: "rc_billing"
                }
              ],
              next_page: null,
              object: "list"
            }),
            {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            }
          )
        );
      }

      if (requestUrl.endsWith("environment=production&limit=100")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  environment: "production",
                  gives_access: false,
                  id: "sub_expired",
                  status: "expired",
                  store: "app_store"
                }
              ],
              next_page:
                "https://api.revenuecat.com/v2/projects/proj15a7ba10/customers/user_test/subscriptions?starting_after=sub_expired&environment=production&limit=100",
              object: "list"
            }),
            {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            }
          )
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            management_url: "https://billing.revenuecat.com/session/paginated"
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await api.POST(
      new Request("https://api.linkdish.ca/api/billing?path=portal", {
        headers: {
          authorization: "Bearer header.payload.signature"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://billing.revenuecat.com/session/paginated"
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getRequestUrl(fetchMock.mock.calls[1]?.[0])).toContain("starting_after=sub_expired");
  });

  it("surfaces RevenueCat portal generation failures for active web subscriptions", async () => {
    vi.stubEnv("REVENUECAT_WEB_MANAGEMENT_URL", "");
    vi.stubEnv("REVENUECAT_V2_SECRET_API_KEY", "rc_v2_test");
    const api = await reloadBillingApi();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void init;
        const requestUrl = getRequestUrl(input);

        if (requestUrl.includes("/customers/")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                items: [
                  {
                    environment: "production",
                    gives_access: true,
                    id: "sub_web",
                    status: "active",
                    store: "rc_billing"
                  }
                ],
                object: "list"
              }),
              {
                headers: {
                  "content-type": "application/json"
                },
                status: 200
              }
            )
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ message: "RevenueCat unavailable" }), {
            headers: {
              "content-type": "application/json"
            },
            status: 503
          })
        );
      })
    );

    const response = await api.POST(
      new Request("https://api.linkdish.ca/api/billing?path=portal", {
        headers: {
          authorization: "Bearer header.payload.signature"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      message: "RevenueCat billing portal request failed (503): RevenueCat unavailable"
    });
  });
});
