import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { buildApp as buildAppType } from "../../../app.js";

let buildApp: typeof buildAppType;

const persistedSettings = new Map<string, string>();
const sortedSets = new Map<string, Map<string, number>>();
const revenueCatRequests: Array<{ body?: unknown; method: string; url: string }> = [];
const revenueCatSubscribers = new Map<
  string,
  {
    entitlements?: Record<string, { expires_date?: string | null }>;
    first_seen?: string | null;
    last_seen?: string | null;
    management_url?: string | null;
    original_app_user_id?: string | null;
    subscriptions?: Record<
      string,
      {
        expires_date?: string | null;
        ownership_type?: string | null;
        period_type?: string | null;
        purchase_date?: string | null;
        store?: string | null;
      }
    >;
  }
>();

const seedIosWaitlistEntry = (record: {
  createdAt: string;
  email: string;
  emailHash: string;
  source?: string;
  userAgent?: string;
}) => {
  persistedSettings.set(
    `linkdish:ios-waitlist:v1:email:${record.emailHash}`,
    JSON.stringify(record)
  );
  sortedSets.set(
    "linkdish:ios-waitlist:v1:emails",
    new Map([[record.emailHash, Date.parse(record.createdAt)]])
  );
};

const parseUpstashCommands = (body: BodyInit | null | undefined): string[][] => {
  if (typeof body !== "string") {
    throw new Error("Expected Upstash mock body to be a JSON string.");
  }

  return JSON.parse(body) as string[][];
};

const handleRevenueCatFetch = (url: string, init?: RequestInit) => {
  revenueCatRequests.push({
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    method: init?.method ?? "GET",
    url
  });

  const subscriberMatch = /\/v1\/subscribers\/([^/]+)/u.exec(url);
  const appUserId = subscriberMatch ? decodeURIComponent(subscriberMatch[1] ?? "") : "";

  if (!appUserId) {
    return Promise.resolve(new Response(JSON.stringify({ message: "Not found" }), { status: 404 }));
  }

  const subscriber = revenueCatSubscribers.get(appUserId) ?? {};

  if (init?.method === "POST") {
    const entitlementMatch = /\/entitlements\/([^/]+)\/promotional$/u.exec(url);

    if (!entitlementMatch) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Unsupported RevenueCat mock request" }), {
          status: 404
        })
      );
    }

    const entitlementId = decodeURIComponent(entitlementMatch[1] ?? "");
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as { end_time_ms?: number }) : {};

    subscriber.entitlements = {
      ...subscriber.entitlements,
      [entitlementId]: {
        expires_date: new Date(body.end_time_ms ?? Date.now()).toISOString()
      }
    };
    revenueCatSubscribers.set(appUserId, subscriber);

    return Promise.resolve(
      new Response(JSON.stringify({ subscriber }), {
        headers: {
          "content-type": "application/json"
        },
        status: 201
      })
    );
  }

  return Promise.resolve(
    new Response(JSON.stringify({ subscriber }), {
      headers: {
        "content-type": "application/json"
      }
    })
  );
};

const getMockRequestUrl = (url: string | URL | Request): string => {
  if (typeof url === "string") {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
};

const mockUpstashFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getMockRequestUrl(url);

  if (requestUrl.startsWith("https://api.revenuecat.com/")) {
    return handleRevenueCatFetch(requestUrl, init);
  }

  const commands = parseUpstashCommands(init?.body);
  const results = commands.map(([command, key, ...args]) => {
    if (!command) {
      return { error: "Invalid command" };
    }

    if (!key && !["PING", "DBSIZE", "INFO"].includes(command)) {
      return { error: "Invalid command" };
    }

    const commandKey = key ?? "";

    if (command === "GET") {
      return { result: persistedSettings.get(commandKey) ?? null };
    }

    if (command === "SET") {
      const [value = ""] = args;
      persistedSettings.set(commandKey, value ?? "");
      return { result: "OK" };
    }

    if (command === "DEL") {
      persistedSettings.delete(commandKey);
      return { result: 1 };
    }

    if (command === "ZCARD") {
      return { result: sortedSets.get(commandKey)?.size ?? 0 };
    }

    if (command === "ZREVRANGE") {
      const [rawStart, rawStop] = args;
      const start = Number(rawStart);
      const stop = Number(rawStop);
      const values = [...(sortedSets.get(commandKey) ?? new Map<string, number>()).entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(start, stop + 1)
        .flatMap(([member, score]) => [member, String(score)]);

      return { result: values };
    }

    if (command === "PING") {
      return { result: "PONG" };
    }

    if (command === "DBSIZE") {
      return { result: persistedSettings.size };
    }

    if (command === "INFO") {
      return { result: "used_memory_human:1 MB\ntotal_commands_processed:1" };
    }

    return { error: `Unsupported command ${command}` };
  });

  return Promise.resolve(
    new Response(JSON.stringify(results), {
      headers: {
        "content-type": "application/json"
      }
    })
  );
});

beforeEach(async () => {
  vi.resetModules();
  persistedSettings.clear();
  sortedSets.clear();
  revenueCatRequests.length = 0;
  revenueCatSubscribers.clear();
  mockUpstashFetch.mockClear();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "test_revenuecat_secret");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test_token");
  vi.stubEnv("OPENAI_API_KEY", "test_openai_key");
  vi.stubGlobal("fetch", mockUpstashFetch);

  ({ buildApp } = await import("../../../app.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const buildTokenProtectedAdminApp = async () => {
  vi.stubEnv("ADMIN_DASHBOARD_TOKEN", "test_admin_token");
  vi.resetModules();
  ({ buildApp } = await import("../../../app.js"));

  return buildApp();
};

const adminTokenHeaders = {
  "x-admin-dashboard-token": "test_admin_token"
};

describe("admin dashboard routes", () => {
  it("rejects query-string tokens and accepts Basic authentication", async () => {
    const app = await buildTokenProtectedAdminApp();
    const queryResponse = await app.inject({
      method: "GET",
      url: "/admin?token=test_admin_token",
      remoteAddress: "203.0.113.80"
    });

    expect(queryResponse.statusCode).toBe(401);
    expect(queryResponse.headers["www-authenticate"]).toContain("Basic");
    expect(queryResponse.headers["cache-control"]).toBe("no-store");

    const basicResponse = await app.inject({
      method: "GET",
      url: "/admin",
      headers: {
        authorization: `Basic ${Buffer.from("admin:test_admin_token").toString("base64")}`
      },
      remoteAddress: "203.0.113.80"
    });

    expect(basicResponse.statusCode).toBe(200);
    expect(basicResponse.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await app.close();
  });

  it("returns a dashboard snapshot for local admin requests", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard",
      remoteAddress: "127.0.0.1"
    });

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();

    expect(body).toBeTypeOf("object");
    expect(body).not.toBeNull();

    const snapshot = body as Record<string, unknown>;

    expect(snapshot.billing).toBeTypeOf("object");
    expect(Array.isArray(snapshot.plans)).toBe(true);
    expect(Array.isArray(snapshot.providerHub)).toBe(true);
    expect(Array.isArray(snapshot.providerLimits)).toBe(true);
    expect(snapshot.runtime).toBeTypeOf("object");
    expect(snapshot.durableAnalytics).toMatchObject({
      failureDrilldown: {
        total: 0,
        distinctVisitors: 0,
        distinctSessions: 0,
        recent: []
      }
    });
    expect(snapshot.iosWaitlist).toMatchObject({
      entries: [],
      total: 0
    });

    const providerHub = snapshot.providerHub as Array<Record<string, unknown>>;
    expect(providerHub.some((provider) => provider.id === "upstash")).toBe(true);
    expect(providerHub.some((provider) => provider.id === "gemini")).toBe(true);

    const providerLimits = snapshot.providerLimits as Array<Record<string, unknown>>;
    expect(providerLimits.some((limit) => limit.id === "api-rate-limit")).toBe(true);
    expect(providerLimits.some((limit) => limit.id === "llm-fallback")).toBe(true);
    expect(providerLimits.some((limit) => limit.id === "upstash")).toBe(true);

    const llm = snapshot.llm as { activeModel?: unknown; catalog?: unknown };
    expect(llm).toBeTypeOf("object");
    expect(Array.isArray(llm.catalog)).toBe(true);

    if (typeof llm.activeModel === "string") {
      expect(
        (llm.catalog as Array<{ model?: string }>).some((model) => model.model === llm.activeModel)
      ).toBe(true);
    }
  });

  it("includes iOS waitlist entries in the dashboard snapshot", async () => {
    seedIosWaitlistEntry({
      createdAt: "2026-05-14T12:00:00.000Z",
      email: "ios.user@example.com",
      emailHash: "ios_user_hash",
      source: "linkdish-site-ios-section",
      userAgent: "vitest browser"
    });
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard",
      remoteAddress: "127.0.0.1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      iosWaitlist: {
        entries: [
          {
            createdAt: "2026-05-14T12:00:00.000Z",
            email: "ios.user@example.com",
            source: "linkdish-site-ios-section",
            userAgent: "vitest browser"
          }
        ],
        total: 1
      }
    });
  });

  it("returns the selected Vercel environment profile", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/dashboard?environment=production",
      remoteAddress: "127.0.0.1"
    });

    const body: unknown = response.json();
    const snapshot = body as {
      environment?: {
        environment?: unknown;
        llm?: unknown;
        plans?: unknown;
      };
    };

    expect(response.statusCode).toBe(200);
    expect(snapshot.environment?.environment).toBe("production");
    expect(snapshot.environment?.llm).toBeTypeOf("object");
    expect(Array.isArray(snapshot.environment?.plans)).toBe(true);
  });

  it("looks up account, billing, and household details by email", async () => {
    const app = await buildTokenProtectedAdminApp();
    const auth = await import("../../auth/auth-service.js");
    const user = await auth.upsertUserByEmail("Lookup@Example.com");
    revenueCatSubscribers.set(user.id, {
      entitlements: {
        Plus: {
          expires_date: "2099-01-01T00:00:00.000Z"
        }
      },
      first_seen: "2026-06-01T00:00:00.000Z",
      last_seen: "2026-06-20T00:00:00.000Z",
      management_url: "https://pay.example.test/customer",
      original_app_user_id: user.id,
      subscriptions: {
        linkdish_plus_monthly: {
          expires_date: "2099-01-01T00:00:00.000Z",
          ownership_type: "PURCHASED",
          period_type: "normal",
          purchase_date: "2026-06-01T00:00:00.000Z",
          store: "app_store"
        }
      }
    });

    const response = await app.inject({
      headers: adminTokenHeaders,
      method: "GET",
      remoteAddress: "127.0.0.1",
      url: "/admin/api/users?email=lookup%40example.com"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      billing: {
        effectivePlan: "plus",
        errors: [],
        revenueCatPlan: "plus",
        subscriber: {
          entitlements: [
            {
              expiresAt: "2099-01-01T00:00:00.000Z",
              id: "Plus"
            }
          ],
          managementUrl: "https://pay.example.test/customer",
          subscriptions: [
            {
              productId: "linkdish_plus_monthly",
              store: "app_store"
            }
          ]
        }
      },
      household: null,
      householdQuota: null,
      user: {
        email: "lookup@example.com",
        id: user.id
      }
    });
  });

  it("returns not found for admin account lookup when the email has no LinkDish account", async () => {
    const app = await buildTokenProtectedAdminApp();

    const response = await app.inject({
      headers: adminTokenHeaders,
      method: "GET",
      remoteAddress: "127.0.0.1",
      url: "/admin/api/users?email=missing%40example.com"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      message: "No active LinkDish account exists for that email."
    });
  });

  it("updates the managed fallback model", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/llm",
      remoteAddress: "127.0.0.1",
      payload: {
        provider: "openai",
        model: "gpt-5-mini"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      llm: {
        selectedProvider: "openai",
        activeModel: "gpt-5-mini",
        updatedBy: "admin",
        configSource: "persisted"
      }
    });
    expect([...persistedSettings.values()][0]).toContain("gpt-5-mini");
  });

  it("rejects provider updates without an explicit model", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "PUT",
      url: "/admin/api/llm",
      remoteAddress: "127.0.0.1",
      payload: {
        provider: "openai"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "Invalid model settings.",
      detail: "Selecting an LLM provider requires an explicit model."
    });
    expect(persistedSettings.size).toBe(0);
  });

  it("resets the managed fallback model to env defaults", async () => {
    const app = buildApp();

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/admin/api/llm",
      remoteAddress: "127.0.0.1",
      payload: {
        provider: "openai",
        model: "gpt-5-mini"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(persistedSettings.size).toBe(1);

    const resetResponse = await app.inject({
      method: "DELETE",
      url: "/admin/api/llm",
      remoteAddress: "127.0.0.1"
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toMatchObject({
      llm: {
        updatedBy: "env",
        configSource: "env"
      }
    });
    expect(persistedSettings.size).toBe(0);
  });

  it("requires a configured admin token before running billing grants", async () => {
    const auth = await import("../../auth/auth-service.js");
    await auth.upsertUserByEmail("locked@example.com");
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      payload: {
        durationDays: 30,
        email: "locked@example.com",
        plan: "family"
      },
      remoteAddress: "127.0.0.1",
      url: "/admin/api/billing/grants"
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      message: "Billing grants require ADMIN_DASHBOARD_TOKEN."
    });
    expect(revenueCatRequests).toHaveLength(0);
  });

  it("grants a RevenueCat billing plan by LinkDish account email", async () => {
    const app = await buildTokenProtectedAdminApp();
    const auth = await import("../../auth/auth-service.js");
    const user = await auth.upsertUserByEmail("Owner@Example.com");

    const response = await app.inject({
      headers: adminTokenHeaders,
      method: "POST",
      payload: {
        durationDays: 30,
        email: " owner@example.com ",
        plan: "family"
      },
      remoteAddress: "127.0.0.1",
      url: "/admin/api/billing/grants"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: {
        billing: {
          effectivePlan: "family",
          revenueCatPlan: "family"
        },
        user: {
          email: "owner@example.com",
          id: user.id
        }
      },
      active: true,
      dryRun: false,
      email: "owner@example.com",
      entitlementId: "Family",
      plan: "family",
      user: {
        id: user.id
      },
      verifiedPlan: "family"
    });
    expect(
      revenueCatRequests.some(
        (request) =>
          request.method === "POST" &&
          request.url ===
            `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(user.id)}/entitlements/Family/promotional`
      )
    ).toBe(true);
    expect(
      [...persistedSettings.values()].some(
        (value) =>
          value.includes('"status":"succeeded"') &&
          value.includes('"email":"owner@example.com"') &&
          value.includes('"plan":"family"')
      )
    ).toBe(true);
  });

  it("dry-runs a billing plan grant without calling RevenueCat", async () => {
    const app = await buildTokenProtectedAdminApp();
    const auth = await import("../../auth/auth-service.js");
    const user = await auth.upsertUserByEmail("dryrun@example.com");

    const response = await app.inject({
      headers: adminTokenHeaders,
      method: "POST",
      payload: {
        dryRun: true,
        durationDays: 7,
        email: "dryrun@example.com",
        plan: "plus"
      },
      remoteAddress: "127.0.0.1",
      url: "/admin/api/billing/grants"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      auditId: null,
      dryRun: true,
      email: "dryrun@example.com",
      entitlementId: "Plus",
      plan: "plus",
      user: {
        id: user.id
      },
      verifiedPlan: null
    });
    expect(revenueCatRequests).toHaveLength(0);
    expect([...persistedSettings.keys()].some((key) => key.includes("billing-grant"))).toBe(false);
  });

  it("does not grant a billing plan when the email has no LinkDish account", async () => {
    const app = await buildTokenProtectedAdminApp();

    const response = await app.inject({
      headers: adminTokenHeaders,
      method: "POST",
      payload: {
        durationDays: 30,
        email: "missing@example.com",
        plan: "family"
      },
      remoteAddress: "127.0.0.1",
      url: "/admin/api/billing/grants"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      message: "No active LinkDish account exists for that email."
    });
    expect(revenueCatRequests).toHaveLength(0);
  });
});
