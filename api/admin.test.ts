import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AdminModule from "./admin.js";

type AdminApi = typeof AdminModule;

let adminApi: AdminApi;

const persistedSettings = new Map<string, string>();
const revenueCatSubscribers = new Map<
  string,
  {
    entitlements?: Record<string, { expires_date?: string | null }>;
  }
>();

const parseUpstashCommands = (body: BodyInit | null | undefined): string[][] => {
  if (typeof body !== "string") {
    throw new Error("Expected Upstash mock body to be a JSON string.");
  }

  return JSON.parse(body) as string[][];
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

const mockFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
  const requestUrl = getMockRequestUrl(url);

  if (requestUrl.startsWith("https://api.revenuecat.com/")) {
    const subscriberMatch = /\/v1\/subscribers\/([^/]+)/u.exec(requestUrl);
    const appUserId = subscriberMatch ? decodeURIComponent(subscriberMatch[1] ?? "") : "";
    const subscriber = revenueCatSubscribers.get(appUserId) ?? {};

    if (init?.method === "POST") {
      const entitlementMatch = /\/entitlements\/([^/]+)\/promotional$/u.exec(requestUrl);
      const entitlementId = decodeURIComponent(entitlementMatch?.[1] ?? "");
      const body =
        typeof init.body === "string" ? (JSON.parse(init.body) as { end_time_ms?: number }) : {};

      subscriber.entitlements = {
        ...subscriber.entitlements,
        [entitlementId]: {
          expires_date: new Date(body.end_time_ms ?? Date.now()).toISOString()
        }
      };
      revenueCatSubscribers.set(appUserId, subscriber);
    }

    return Promise.resolve(
      new Response(JSON.stringify({ subscriber }), {
        headers: {
          "content-type": "application/json"
        },
        status: init?.method === "POST" ? 201 : 200
      })
    );
  }

  const commands = parseUpstashCommands(init?.body);
  const results = commands.map(([command, key, value]) => {
    if (!command || !key) {
      return { error: "Invalid command" };
    }

    if (command === "GET") {
      return { result: persistedSettings.get(key) ?? null };
    }

    if (command === "SET") {
      persistedSettings.set(key, value ?? "");
      return { result: "OK" };
    }

    if (command === "DEL") {
      persistedSettings.delete(key);
      return { result: 1 };
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

const request = (path: string, init?: RequestInit) =>
  new Request(`https://api.linkdish.ca${path}`, init);

beforeEach(async () => {
  vi.resetModules();
  persistedSettings.clear();
  revenueCatSubscribers.clear();
  mockFetch.mockClear();
  vi.stubEnv("ADMIN_DASHBOARD_TOKEN", "test_admin_token");
  vi.stubEnv("REVENUECAT_SECRET_API_KEY", "test_revenuecat_secret");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.test");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test_token");
  vi.stubEnv("OPENAI_API_KEY", "test_openai_key");
  vi.stubGlobal("fetch", mockFetch);

  adminApi = await import("./admin.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel admin dashboard adapter", () => {
  it("requires the admin token", async () => {
    const response = await adminApi.GET(request("/api/admin"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the dashboard HTML with valid Basic authentication", async () => {
    const response = await adminApi.GET(
      request("/api/admin", {
        headers: {
          authorization: `Basic ${Buffer.from("admin:test_admin_token").toString("base64")}`
        }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("LinkDish Admin");
    expect(html).toContain("Provider Hub");
    expect(html).toContain("Extraction Failure Drilldown");
    expect(html).toContain("Import ID");
    expect(html).not.toContain('searchParams).get("token")');
  });

  it("does not accept the admin token in the query string", async () => {
    const response = await adminApi.GET(request("/api/admin?token=test_admin_token"));

    expect(response.status).toBe(401);
  });

  it("returns the dashboard snapshot through the rewritten API path", async () => {
    const response = await adminApi.GET(
      request("/api/admin?path=api/dashboard", {
        headers: {
          "x-admin-dashboard-token": "test_admin_token"
        }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      security: {
        authMode: "ADMIN_DASHBOARD_TOKEN"
      }
    });
  });

  it("looks up user account details through the rewritten API path", async () => {
    const auth = await import("../services/extractor-api/src/modules/auth/auth-service.js");
    const user = await auth.upsertUserByEmail("adapter@example.com");
    revenueCatSubscribers.set(user.id, {
      entitlements: {
        Plus: {
          expires_date: "2099-01-01T00:00:00.000Z"
        }
      }
    });

    const response = await adminApi.GET(
      request("/api/admin?path=api/users&email=adapter%40example.com", {
        headers: {
          "x-admin-dashboard-token": "test_admin_token"
        }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      billing: {
        effectivePlan: "plus",
        revenueCatPlan: "plus"
      },
      user: {
        email: "adapter@example.com",
        id: user.id
      }
    });
  });

  it("grants a plan through the rewritten API path", async () => {
    const auth = await import("../services/extractor-api/src/modules/auth/auth-service.js");
    const user = await auth.upsertUserByEmail("grant-adapter@example.com");

    const response = await adminApi.POST(
      request("/api/admin?path=api/billing/grants", {
        body: JSON.stringify({
          durationDays: 30,
          email: "grant-adapter@example.com",
          plan: "family"
        }),
        headers: {
          "content-type": "application/json",
          "x-admin-dashboard-token": "test_admin_token"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      account: {
        billing: {
          effectivePlan: "family",
          revenueCatPlan: "family"
        },
        user: {
          id: user.id
        }
      },
      active: true,
      email: "grant-adapter@example.com",
      plan: "family",
      verifiedPlan: "family"
    });
  });

  it("persists model updates and resets through the rewritten API path", async () => {
    const updateResponse = await adminApi.PUT(
      request("/api/admin?path=api/llm", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-admin-dashboard-token": "test_admin_token"
        },
        body: JSON.stringify({
          provider: "openai",
          model: "gpt-5-mini"
        })
      })
    );

    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      llm: {
        selectedProvider: "openai",
        activeModel: "gpt-5-mini",
        configSource: "persisted"
      }
    });
    expect([...persistedSettings.values()][0]).toContain("gpt-5-mini");

    const resetResponse = await adminApi.DELETE(
      request("/api/admin?path=api/llm", {
        method: "DELETE",
        headers: {
          "x-admin-dashboard-token": "test_admin_token"
        }
      })
    );

    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      llm: {
        configSource: "env"
      }
    });
    expect(persistedSettings.size).toBe(0);
  });

  it("rejects provider updates without an explicit model", async () => {
    const response = await adminApi.PUT(
      request("/api/admin?path=api/llm", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-admin-dashboard-token": "test_admin_token"
        },
        body: JSON.stringify({
          provider: "openai"
        })
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: "Invalid model settings.",
      detail: "Selecting an LLM provider requires an explicit model."
    });
    expect(persistedSettings.size).toBe(0);
  });
});
