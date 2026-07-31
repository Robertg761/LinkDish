import { z } from "zod";

import { extractorApiEnv } from "../../config/env.js";

import { getRuntimeEnvironmentName } from "./environment-profiles.js";

import type { AdminLlmProvider } from "./model-control.js";

const persistedModelSettingsSchema = z.object({
  provider: z.enum(["gemini", "openai", "none"]),
  model: z.string().trim().nullable(),
  updatedAt: z.string(),
  updatedBy: z.literal("admin")
});

interface UpstashResponse {
  error?: string;
  result?: unknown;
}

export type PersistedAdminModelSettings = z.infer<typeof persistedModelSettingsSchema>;

export class AdminModelSettingsStoreUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminModelSettingsStoreUnavailableError";
  }
}

const settingsVersion = "v1";

export const isAdminModelSettingsStoreConfigured = (): boolean =>
  Boolean(extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN);

export const getAdminModelSettingsKey = (): string =>
  `linkdish:admin:${settingsVersion}:${getRuntimeEnvironmentName()}:llm-settings`;

const getUpstashUrl = (path: string): string => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new AdminModelSettingsStoreUnavailableError("Upstash Redis REST is not configured.");
  }

  return `${extractorApiEnv.UPSTASH_REDIS_REST_URL}${path}`;
};

const getHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
  "content-type": "application/json"
});

const runUpstashCommand = async (command: string[]): Promise<UpstashResponse> => {
  const response = await fetch(getUpstashUrl("/multi-exec"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify([command])
  });

  if (!response.ok) {
    throw new AdminModelSettingsStoreUnavailableError(
      `Upstash model settings command failed with ${response.status}.`
    );
  }

  const body = (await response.json()) as UpstashResponse[];
  const result = body[0];

  if (result?.error) {
    throw new AdminModelSettingsStoreUnavailableError(result.error);
  }

  return result ?? {};
};

export const readPersistedAdminModelSettings =
  async (): Promise<PersistedAdminModelSettings | null> => {
    if (!isAdminModelSettingsStoreConfigured()) {
      return null;
    }

    const result = await runUpstashCommand(["GET", getAdminModelSettingsKey()]);

    if (result.result == null) {
      return null;
    }

    if (typeof result.result !== "string") {
      throw new AdminModelSettingsStoreUnavailableError(
        "Upstash model settings returned an invalid response."
      );
    }

    const parsedJson = JSON.parse(result.result) as unknown;
    return persistedModelSettingsSchema.parse(parsedJson);
  };

export const writePersistedAdminModelSettings = async (settings: {
  provider: AdminLlmProvider;
  model: string | null;
}): Promise<PersistedAdminModelSettings> => {
  if (!isAdminModelSettingsStoreConfigured()) {
    throw new AdminModelSettingsStoreUnavailableError("Upstash Redis REST is not configured.");
  }

  const persistedSettings = persistedModelSettingsSchema.parse({
    ...settings,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin"
  });

  await runUpstashCommand(["SET", getAdminModelSettingsKey(), JSON.stringify(persistedSettings)]);

  return persistedSettings;
};

export const deletePersistedAdminModelSettings = async (): Promise<void> => {
  if (!isAdminModelSettingsStoreConfigured()) {
    throw new AdminModelSettingsStoreUnavailableError("Upstash Redis REST is not configured.");
  }

  await runUpstashCommand(["DEL", getAdminModelSettingsKey()]);
};
