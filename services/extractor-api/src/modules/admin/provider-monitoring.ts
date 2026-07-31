import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractorApiEnv } from "../../config/env.js";

export type AdminProviderConnectionStatus =
  | "ok"
  | "watch"
  | "upgrade"
  | "missing"
  | "error"
  | "unknown";

export interface AdminProviderMetric {
  label: string;
  value: string;
  detail?: string;
  utilizationPct?: number | null;
}

export interface AdminProviderAction {
  label: string;
  href: string;
}

export interface AdminProviderLiveSnapshot {
  id: string;
  provider: string;
  status: AdminProviderConnectionStatus;
  summary: string;
  lastCheckedAt: string;
  metrics: AdminProviderMetric[];
  actions: AdminProviderAction[];
  source: string;
  error?: string;
}

interface ProviderFetchResult {
  headers: Headers;
  json: unknown;
  ok: boolean;
  status: number;
  statusText: string;
}

const providerFetchTimeoutMs = 5_000;

const nowIso = (): string => new Date().toISOString();

const percent = (used: number, limit: number): number | null =>
  limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null;

const statusFromUtilization = (utilizationPct: number | null): AdminProviderConnectionStatus => {
  if (utilizationPct == null) {
    return "unknown";
  }

  if (utilizationPct >= 90) {
    return "upgrade";
  }

  if (utilizationPct >= 70) {
    return "watch";
  }

  return "ok";
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Provider request failed.";

const providerJsonFetch = async (
  url: string,
  init: RequestInit = {}
): Promise<ProviderFetchResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, providerFetchTimeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    let json: unknown = null;

    if (text.trim()) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = text;
      }
    }

    return {
      headers: response.headers,
      json,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText
    };
  } finally {
    clearTimeout(timeout);
  }
};

const missingSnapshot = (
  id: string,
  provider: string,
  summary: string,
  actions: AdminProviderAction[],
  source = "Environment configuration"
): AdminProviderLiveSnapshot => ({
  id,
  provider,
  status: "missing",
  summary,
  lastCheckedAt: nowIso(),
  metrics: [],
  actions,
  source
});

const errorSnapshot = (
  id: string,
  provider: string,
  error: unknown,
  actions: AdminProviderAction[],
  source = "Provider API"
): AdminProviderLiveSnapshot => ({
  id,
  provider,
  status: "error",
  summary: "Live provider request failed.",
  lastCheckedAt: nowIso(),
  metrics: [],
  actions,
  source,
  error: getErrorMessage(error)
});

const getObjectRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const getHeaderNumber = (headers: Headers, name: string): number | null => {
  const rawValue = headers.get(name);
  const numeric = rawValue == null ? NaN : Number(rawValue);
  return Number.isFinite(numeric) ? numeric : null;
};

const getOptionalProcessEnv = (name: string): string | null => {
  const value = process.env[name]?.trim();
  return value ? value : null;
};

const getLocalVercelProjectMetadata = (): Record<string, unknown> => {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".vercel/project.json"), "utf8");
    return getObjectRecord(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
};

const collectNumericFields = (
  value: unknown,
  prefix = "",
  collected: AdminProviderMetric[] = []
): AdminProviderMetric[] => {
  if (collected.length >= 6) {
    return collected;
  }

  if (typeof value !== "object" || value === null) {
    return collected;
  }

  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;

    if (typeof childValue === "number" && Number.isFinite(childValue)) {
      collected.push({
        label,
        value: String(childValue)
      });
    } else if (typeof childValue === "object" && childValue !== null) {
      collectNumericFields(childValue, label, collected);
    }

    if (collected.length >= 6) {
      break;
    }
  }

  return collected;
};

const getGeminiSnapshot = async (): Promise<AdminProviderLiveSnapshot> => {
  const actions = [
    {
      label: "Gemini usage",
      href: "https://aistudio.google.com/usage"
    },
    {
      label: "Gemini rate limits",
      href: "https://ai.google.dev/gemini-api/docs/rate-limits"
    }
  ];

  if (!extractorApiEnv.GEMINI_API_KEY) {
    return missingSnapshot(
      "gemini",
      "Gemini",
      "Set GEMINI_API_KEY to check Gemini API access.",
      actions,
      "Gemini models API"
    );
  }

  try {
    const response = await providerJsonFetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
        extractorApiEnv.GEMINI_API_KEY
      )}`
    );

    if (!response.ok) {
      throw new Error(`Gemini models API returned ${response.status} ${response.statusText}.`);
    }

    const models = getObjectRecord(response.json).models;
    const modelCount = Array.isArray(models) ? models.length : 0;

    return {
      id: "gemini",
      provider: "Gemini",
      status: "ok",
      summary: "Gemini API key can read available models.",
      lastCheckedAt: nowIso(),
      metrics: [
        {
          label: "Visible models",
          value: String(modelCount)
        }
      ],
      actions,
      source: "Gemini models API"
    };
  } catch (error) {
    return errorSnapshot("gemini", "Gemini", error, actions, "Gemini models API");
  }
};

const parseUpstashInfo = (info: string): Record<string, string> =>
  Object.fromEntries(
    info
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes(":"))
      .map((line) => {
        const [key = "", ...valueParts] = line.split(":");
        return [key, valueParts.join(":")];
      })
  );

const getUpstashSnapshot = async (): Promise<AdminProviderLiveSnapshot> => {
  const actions = [
    {
      label: "Upstash console",
      href: "https://console.upstash.com/redis"
    }
  ];

  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    return missingSnapshot(
      "upstash",
      "Upstash Redis",
      "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for live Redis data.",
      actions,
      "Upstash Redis REST API"
    );
  }

  try {
    const response = await providerJsonFetch(`${extractorApiEnv.UPSTASH_REDIS_REST_URL}/pipeline`, {
      body: JSON.stringify([["PING"], ["DBSIZE"], ["INFO"]]),
      headers: {
        authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
        "content-type": "application/json"
      },
      method: "POST"
    });

    if (!response.ok) {
      throw new Error(`Upstash REST API returned ${response.status} ${response.statusText}.`);
    }

    const results = Array.isArray(response.json) ? response.json : [];
    const ping = getObjectRecord(results[0]).result;
    const dbSize = getObjectRecord(results[1]).result;
    const info = getObjectRecord(results[2]).result;
    const parsedInfo = typeof info === "string" ? parseUpstashInfo(info) : {};

    return {
      id: "upstash",
      provider: "Upstash Redis",
      status: ping === "PONG" ? "ok" : "watch",
      summary: ping === "PONG" ? "Redis REST API is reachable." : "Redis REST API responded oddly.",
      lastCheckedAt: nowIso(),
      metrics: [
        {
          label: "Keys",
          value: typeof dbSize === "number" ? String(dbSize) : "Unknown"
        },
        {
          label: "Used memory",
          value: parsedInfo.used_memory_human ?? parsedInfo.used_memory ?? "Unknown"
        },
        {
          label: "Commands processed",
          value: parsedInfo.total_commands_processed ?? "Unknown"
        }
      ],
      actions,
      source: "Upstash Redis REST pipeline"
    };
  } catch (error) {
    return errorSnapshot("upstash", "Upstash Redis", error, actions, "Upstash Redis REST API");
  }
};

const getRevenueCatSnapshot = async (): Promise<AdminProviderLiveSnapshot> => {
  const actions = [
    {
      label: "RevenueCat overview",
      href: "https://app.revenuecat.com/overview"
    },
    {
      label: "RevenueCat API keys",
      href: "https://app.revenuecat.com/projects"
    }
  ];

  if (!extractorApiEnv.REVENUECAT_SECRET_API_KEY) {
    return missingSnapshot(
      "revenuecat",
      "RevenueCat",
      "Set REVENUECAT_SECRET_API_KEY for live billing API checks.",
      actions,
      "RevenueCat Subscriber API"
    );
  }

  try {
    if (!extractorApiEnv.REVENUECAT_PROJECT_ID) {
      return {
        id: "revenuecat",
        provider: "RevenueCat",
        status: "watch",
        summary:
          "RevenueCat secret key is configured. Add REVENUECAT_PROJECT_ID to enable read-only metrics.",
        lastCheckedAt: nowIso(),
        metrics: [
          {
            label: "Secret API key",
            value: "Configured"
          },
          {
            label: "Plus entitlement",
            value: extractorApiEnv.REVENUECAT_PLUS_ENTITLEMENT_ID
          },
          {
            label: "Family entitlement",
            value: extractorApiEnv.REVENUECAT_FAMILY_ENTITLEMENT_ID
          }
        ],
        actions,
        source: "Environment configuration"
      };
    }

    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const url = new URL(
      `https://api.revenuecat.com/v2/projects/${encodeURIComponent(
        extractorApiEnv.REVENUECAT_PROJECT_ID
      )}/metrics/overview`
    );
    url.searchParams.set("start_time", startTime);
    url.searchParams.set("end_time", endTime);

    const response = await providerJsonFetch(url.toString(), {
      headers: {
        authorization: `Bearer ${extractorApiEnv.REVENUECAT_SECRET_API_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`RevenueCat metrics API returned ${response.status} ${response.statusText}.`);
    }

    const metrics = collectNumericFields(response.json);

    return {
      id: "revenuecat",
      provider: "RevenueCat",
      status: "ok",
      summary: "RevenueCat project metrics loaded.",
      lastCheckedAt: nowIso(),
      metrics: metrics.length > 0 ? metrics : [{ label: "Response", value: "Loaded" }],
      actions,
      source: "RevenueCat API v2 metrics overview"
    };
  } catch (error) {
    return errorSnapshot(
      "revenuecat",
      "RevenueCat",
      error,
      actions,
      "RevenueCat API v2 metrics overview"
    );
  }
};

const getResendSnapshot = async (): Promise<AdminProviderLiveSnapshot> => {
  const actions = [
    {
      label: "Resend usage",
      href: "https://resend.com/settings/usage"
    },
    {
      label: "Resend logs",
      href: "https://resend.com/emails"
    }
  ];

  if (!extractorApiEnv.RESEND_API_KEY) {
    return missingSnapshot(
      "resend",
      "Resend",
      "Set RESEND_API_KEY to check email API rate and quota headers.",
      actions,
      "Resend API"
    );
  }

  try {
    const response = await providerJsonFetch("https://api.resend.com/domains", {
      headers: {
        authorization: `Bearer ${extractorApiEnv.RESEND_API_KEY}`
      }
    });
    const rateLimit = getHeaderNumber(response.headers, "ratelimit-limit");
    const rateRemaining = getHeaderNumber(response.headers, "ratelimit-remaining");
    const monthlyQuota = response.headers.get("x-resend-monthly-quota");
    const utilization =
      rateLimit != null && rateRemaining != null
        ? percent(rateLimit - rateRemaining, rateLimit)
        : null;

    if (!response.ok) {
      throw new Error(`Resend API returned ${response.status} ${response.statusText}.`);
    }

    return {
      id: "resend",
      provider: "Resend",
      status: statusFromUtilization(utilization),
      summary: "Resend API is reachable.",
      lastCheckedAt: nowIso(),
      metrics: [
        {
          label: "Rate limit remaining",
          value:
            rateLimit != null && rateRemaining != null
              ? `${rateRemaining}/${rateLimit}`
              : "Not returned",
          utilizationPct: utilization
        },
        {
          label: "Monthly quota header",
          value: monthlyQuota ?? "Not returned"
        }
      ],
      actions,
      source: "Resend Domains API response headers"
    };
  } catch (error) {
    return errorSnapshot("resend", "Resend", error, actions, "Resend API");
  }
};

const getVercelSnapshot = async (): Promise<AdminProviderLiveSnapshot> => {
  const localProject = getLocalVercelProjectMetadata();
  const projectId =
    extractorApiEnv.VERCEL_PROJECT_ID ??
    getOptionalProcessEnv("VERCEL_PROJECT_ID") ??
    (typeof localProject.projectId === "string" ? localProject.projectId : null);
  const teamId =
    extractorApiEnv.VERCEL_TEAM_ID ??
    getOptionalProcessEnv("VERCEL_TEAM_ID") ??
    (typeof localProject.orgId === "string" ? localProject.orgId : null);
  const projectName =
    typeof localProject.projectName === "string"
      ? localProject.projectName
      : getOptionalProcessEnv("VERCEL_PROJECT_NAME");
  const runtimeUrl =
    getOptionalProcessEnv("VERCEL_PROJECT_PRODUCTION_URL") ?? getOptionalProcessEnv("VERCEL_URL");
  const runtimeEnv = getOptionalProcessEnv("VERCEL_ENV");
  const gitRef = getOptionalProcessEnv("VERCEL_GIT_COMMIT_REF");
  const gitSha = getOptionalProcessEnv("VERCEL_GIT_COMMIT_SHA");
  const region = getOptionalProcessEnv("VERCEL_REGION");
  const actions = [
    {
      label: "Vercel usage",
      href: "https://vercel.com/dashboard/usage"
    },
    {
      label: "Vercel project",
      href: "https://vercel.com/dashboard"
    }
  ];

  if (!extractorApiEnv.VERCEL_API_TOKEN) {
    const metrics: AdminProviderMetric[] = [
      {
        label: "Project",
        value: projectName ?? projectId ?? "Unknown"
      },
      {
        label: "Environment",
        value: runtimeEnv ?? "Local"
      },
      {
        label: "URL",
        value: runtimeUrl ?? "Not provided"
      },
      {
        label: "Git ref",
        value: gitRef ?? "Not provided",
        ...(gitSha ? { detail: gitSha.slice(0, 12) } : {})
      },
      {
        label: "Region",
        value: region ?? "Not provided"
      }
    ];

    if (projectId || runtimeEnv || runtimeUrl || projectName) {
      return {
        id: "vercel",
        provider: "Vercel",
        status: projectId || runtimeEnv ? "ok" : "watch",
        summary:
          "Using Vercel project/runtime metadata. Add VERCEL_API_TOKEN only if REST deployment data is needed.",
        lastCheckedAt: nowIso(),
        metrics,
        actions,
        source: projectId ? "Vercel project metadata" : "Vercel runtime environment"
      };
    }

    return missingSnapshot(
      "vercel",
      "Vercel",
      "Run inside Vercel or link the project locally for runtime deployment metadata.",
      actions,
      "Vercel runtime metadata"
    );
  }

  if (!projectId) {
    return missingSnapshot(
      "vercel",
      "Vercel",
      "VERCEL_API_TOKEN is set, but no Vercel project id is available.",
      actions,
      "Vercel REST API"
    );
  }

  try {
    const teamQuery = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const projectResponse = await providerJsonFetch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}${teamQuery}`,
      {
        headers: {
          authorization: `Bearer ${extractorApiEnv.VERCEL_API_TOKEN}`
        }
      }
    );

    if (!projectResponse.ok) {
      throw new Error(
        `Vercel project API returned ${projectResponse.status} ${projectResponse.statusText}.`
      );
    }

    const deploymentsUrl = new URL("https://api.vercel.com/v6/deployments");
    deploymentsUrl.searchParams.set("limit", "1");
    deploymentsUrl.searchParams.set("projectId", projectId);

    if (teamId) {
      deploymentsUrl.searchParams.set("teamId", teamId);
    }

    const deploymentsResponse = await providerJsonFetch(deploymentsUrl.toString(), {
      headers: {
        authorization: `Bearer ${extractorApiEnv.VERCEL_API_TOKEN}`
      }
    });
    const rateLimit = getHeaderNumber(projectResponse.headers, "x-ratelimit-limit");
    const rateRemaining = getHeaderNumber(projectResponse.headers, "x-ratelimit-remaining");
    const project = getObjectRecord(projectResponse.json);
    const deployments = getObjectRecord(deploymentsResponse.json).deployments;
    const latestDeployment = Array.isArray(deployments) ? getObjectRecord(deployments[0]) : {};
    const utilization =
      rateLimit != null && rateRemaining != null
        ? percent(rateLimit - rateRemaining, rateLimit)
        : null;

    return {
      id: "vercel",
      provider: "Vercel",
      status: statusFromUtilization(utilization),
      summary: "Vercel project API is reachable.",
      lastCheckedAt: nowIso(),
      metrics: [
        {
          label: "Project",
          value: typeof project.name === "string" ? project.name : (projectName ?? projectId)
        },
        {
          label: "Latest deployment",
          value: typeof latestDeployment.state === "string" ? latestDeployment.state : "Unknown"
        },
        {
          label: "API rate remaining",
          value:
            rateLimit != null && rateRemaining != null
              ? `${rateRemaining}/${rateLimit}`
              : "Not returned",
          utilizationPct: utilization
        }
      ],
      actions,
      source: "Vercel REST API"
    };
  } catch (error) {
    return errorSnapshot("vercel", "Vercel", error, actions, "Vercel REST API");
  }
};

export const getAdminProviderLiveSnapshots = async (): Promise<AdminProviderLiveSnapshot[]> =>
  Promise.all([
    getVercelSnapshot(),
    getUpstashSnapshot(),
    getRevenueCatSnapshot(),
    getResendSnapshot(),
    getGeminiSnapshot()
  ]);
