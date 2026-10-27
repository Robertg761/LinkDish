import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AdminModule from "./admin.js";

type AdminApi = typeof AdminModule;

let adminApi: AdminApi;

const persistedSettings = new Map<string, string>();
const sortedSets = new Map<string, Map<string, number>>();
const keyTtls = new Map<string, number>();
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
  const results = commands.map(([command, key, value, ...args]) => {
    if (!command || !key) {
      return { error: "Invalid command" };
    }

    if (command === "GET") {
      return { result: persistedSettings.get(key) ?? null };
    }

    if (command === "INCR") {
      const next = Number(persistedSettings.get(key) ?? "0") + 1;
      persistedSettings.set(key, String(next));
      return { result: next };
    }

    if (command === "EXPIRE") {
      if (!keyTtls.has(key)) {
        keyTtls.set(key, Number(value));
      }
      return { result: 1 };
    }

    if (command === "TTL") {
      return { result: persistedSettings.has(key) ? (keyTtls.get(key) ?? -1) : -2 };
    }

    if (command === "ZADD") {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(args[0] ?? "", Number(value));
      sortedSets.set(key, set);
      return { result: 1 };
    }

    if (command === "ZREMRANGEBYSCORE" || command === "ZREMRANGEBYRANK") {
      return { result: 0 };
    }

    if (command === "ZREVRANGE") {
      const stop = Number(args[0]);
      const members = [...(sortedSets.get(key) ?? new Map<string, number>()).entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(Number(value), stop + 1)
        .flatMap(([member, score]) => [member, String(score)]);
      return { result: members };
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
  sortedSets.clear();
  keyTtls.clear();
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
        authMode: "Shared ADMIN_DASHBOARD_TOKEN (legacy)"
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

  describe("named tokens, lockout and audit log", () => {
    const robertToken = "robert_token_0123456789abcdef0123456789";
    const basic = (username: string, token: string) =>
      `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;

    const loadWithNamedTokens = async () => {
      vi.stubEnv("ADMIN_DASHBOARD_TOKENS", `robert:${robertToken}`);
      vi.stubEnv("ADMIN_AUTH_FAILURE_LIMIT_MAX", "3");
      vi.resetModules();
      adminApi = await import("./admin.js");
    };

    const listAudit = async () => {
      const audit = await import("../services/extractor-api/src/modules/admin/admin-audit.js");
      return audit.listAdminAuditEvents();
    };

    it("accepts a named token with its own Basic username only", async () => {
      await loadWithNamedTokens();

      const named = await adminApi.GET(
        request("/api/admin", { headers: { authorization: basic("robert", robertToken) } })
      );
      const wrongName = await adminApi.GET(
        request("/api/admin", { headers: { authorization: basic("admin", robertToken) } })
      );
      const legacy = await adminApi.GET(
        request("/api/admin", { headers: { authorization: basic("admin", "test_admin_token") } })
      );

      expect(named.status).toBe(200);
      expect(wrongName.status).toBe(401);
      expect(legacy.status).toBe(200);
    });

    it("locks a network out after repeated bad tokens, even for a valid token", async () => {
      await loadWithNamedTokens();

      const unauthenticated = await adminApi.GET(request("/api/admin"));
      expect(unauthenticated.status).toBe(401);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await adminApi.GET(
          request("/api/admin", { headers: { "x-admin-dashboard-token": "wrong-token" } })
        );
        expect(response.status).toBe(401);
      }

      const locked = await adminApi.GET(
        request("/api/admin", { headers: { authorization: basic("robert", robertToken) } })
      );

      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).toBe("900");
      expect(locked.headers.get("cache-control")).toBe("no-store");

      const audit = await listAudit();
      expect(audit.filter((entry) => entry.action === "auth.failed")).toHaveLength(3);
      expect(audit.filter((entry) => entry.action === "auth.locked")).toHaveLength(1);
      expect(audit.every((entry) => entry.actor === null && entry.outcome === "denied")).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("wrong-token");
    });

    it("hides audit entries older than the retention period", async () => {
      await loadWithNamedTokens();
      const audit = await import("../services/extractor-api/src/modules/admin/admin-audit.js");
      await audit.recordAdminAuditEvent(
        { action: "llm.reset", actor: "robert", ip: "203.0.113.1", outcome: "success" },
        new Date(Date.now() - 181 * 86_400_000)
      );
      expect(sortedSets.get("linkdish:admin:audit:v1")?.size).toBe(1);
      expect(await audit.listAdminAuditEvents()).toHaveLength(0);
      expect([...keyTtls.values()]).toContain(180 * 86_400);
    });

    it("holds a concurrent burst of bad tokens to the limit", async () => {
      await loadWithNamedTokens();

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          adminApi.GET(
            request("/api/admin", { headers: { "x-admin-dashboard-token": `guess-${index}` } })
          )
        )
      );
      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 401)).toHaveLength(3);
      expect(statuses.filter((status) => status === 429)).toHaveLength(5);
      expect((await listAudit()).filter((entry) => entry.action === "auth.failed")).toHaveLength(3);
    });

    it("attributes plan grants to the named admin and lists them in the snapshot", async () => {
      await loadWithNamedTokens();
      const auth = await import("../services/extractor-api/src/modules/auth/auth-service.js");
      await auth.upsertUserByEmail("audited@example.com");

      const grant = await adminApi.POST(
        request("/api/admin?path=api/billing/grants", {
          body: JSON.stringify({ durationDays: 30, email: "audited@example.com", plan: "plus" }),
          headers: {
            authorization: basic("robert", robertToken),
            "content-type": "application/json",
            "sec-fetch-site": "same-origin"
          },
          method: "POST"
        })
      );

      expect(grant.status).toBe(200);
      const grantRecord = [...persistedSettings.entries()].find(([key]) =>
        key.startsWith("linkdish:admin:billing-grant:")
      );
      expect(grantRecord?.[1]).toContain('"grantedBy":"admin-api:robert"');

      const snapshot = await adminApi.GET(
        request("/api/admin?path=api/dashboard", {
          headers: { authorization: basic("robert", robertToken) }
        })
      );
      const body = (await snapshot.json()) as {
        adminAudit: { entries: Array<Record<string, unknown>>; error: string | null };
        security: { authMode: string };
      };

      expect(body.security.authMode).toBe("Named tokens: robert + shared legacy token");
      expect(body.adminAudit.error).toBeNull();
      expect(body.adminAudit.entries[0]).toMatchObject({
        action: "billing.grant",
        actor: "robert",
        detail: { email: "audited@example.com", plan: "plus" },
        outcome: "success"
      });
    });

    it("rejects cross-site and non-JSON admin writes before running them", async () => {
      await loadWithNamedTokens();
      const auth = await import("../services/extractor-api/src/modules/auth/auth-service.js");
      await auth.upsertUserByEmail("csrf@example.com");
      const body = JSON.stringify({ durationDays: 30, email: "csrf@example.com", plan: "plus" });

      const crossSite = await adminApi.POST(
        request("/api/admin?path=api/billing/grants", {
          body,
          headers: {
            authorization: basic("robert", robertToken),
            "content-type": "application/json",
            "sec-fetch-site": "cross-site"
          },
          method: "POST"
        })
      );
      const plainText = await adminApi.POST(
        request("/api/admin?path=api/billing/grants", {
          body,
          headers: {
            authorization: basic("robert", robertToken),
            "content-type": "text/plain"
          },
          method: "POST"
        })
      );
      const crossSiteDelete = await adminApi.DELETE(
        request("/api/admin?path=api/llm", {
          headers: {
            authorization: basic("robert", robertToken),
            "sec-fetch-site": "same-site"
          },
          method: "DELETE"
        })
      );

      expect(crossSite.status).toBe(403);
      expect(plainText.status).toBe(415);
      expect(crossSiteDelete.status).toBe(403);
      expect(revenueCatSubscribers.size).toBe(0);
      expect(await listAudit()).toHaveLength(0);
    });

    it("falls back to the token check when the store stalls", async () => {
      await loadWithNamedTokens();
      mockFetch.mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out.", "TimeoutError"))
          );
        });
      });

      const response = await adminApi.GET(
        request("/api/admin", { headers: { authorization: basic("robert", robertToken) } })
      );

      expect(response.status).toBe(200);
    });
  });
});

describe("analytics retention cron", () => {
  const importWithEnv = async (env: Record<string, string>) => {
    vi.resetModules();

    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    return import("./admin.js");
  };

  const cronRequest = (secret?: string) =>
    request("/api/admin?path=cron/analytics-retention", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {}
    });

  it("is unavailable until CRON_SECRET is set", async () => {
    const api = await importWithEnv({ CRON_SECRET: "" });

    expect((await api.GET(cronRequest("anything"))).status).toBe(503);
  });

  it("rejects a missing or wrong secret, including the admin dashboard token", async () => {
    const api = await importWithEnv({ CRON_SECRET: "test_cron_secret" });

    expect((await api.GET(cronRequest())).status).toBe(401);
    expect((await api.GET(cronRequest("wrong_secret"))).status).toBe(401);
    expect((await api.GET(cronRequest("test_admin_token"))).status).toBe(401);
  });

  it("runs the purge with the cron secret, even with the dashboard disabled", async () => {
    const api = await importWithEnv({
      ADMIN_DASHBOARD_ENABLED: "false",
      ANALYTICS_DATABASE_URL: "",
      CRON_SECRET: "test_cron_secret"
    });

    const response = await api.GET(cronRequest("test_cron_secret"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      complete: true,
      configured: false
    });
  });

  it("does not open the dashboard to the cron secret", async () => {
    const api = await importWithEnv({ CRON_SECRET: "test_cron_secret" });

    expect(
      (
        await api.GET(
          request("/api/admin?path=api/dashboard", {
            headers: { authorization: "Bearer test_cron_secret" }
          })
        )
      ).status
    ).toBe(401);
  });
});
