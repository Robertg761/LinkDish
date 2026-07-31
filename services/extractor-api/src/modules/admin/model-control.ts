import { extractorApiEnv } from "../../config/env.js";
import { createFallbackExtractor } from "../extract/fallback/index.js";

import {
  deletePersistedAdminModelSettings,
  getAdminModelSettingsKey,
  isAdminModelSettingsStoreConfigured,
  readPersistedAdminModelSettings,
  writePersistedAdminModelSettings
} from "./model-settings-store.js";

import type { FallbackRecipeExtractor } from "../extract/types.js";

export type AdminLlmProvider = "gemini" | "openai" | "none";

export interface AdminModelPrice {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  source: "provider_docs" | "unverified";
  note?: string;
}

export interface AdminModelOption {
  provider: Exclude<AdminLlmProvider, "none">;
  model: string;
  label: string;
  price: AdminModelPrice;
}

export interface AdminModelSettings {
  selectedProvider: AdminLlmProvider;
  geminiModel: string | null;
  openAiModel: string | null;
  updatedAt: string | null;
  updatedBy: "env" | "admin";
  configSource: "env" | "persisted";
}

export interface AdminModelState extends AdminModelSettings {
  runtimeProvider: FallbackRecipeExtractor["providerName"];
  available: boolean;
  activeModel: string | null;
  credentials: {
    gemini: boolean;
    openai: boolean;
  };
  catalog: AdminModelOption[];
  persistence: {
    configured: boolean;
    key: string;
    lastLoadedAt: string | null;
    loadError: string | null;
  };
  notes: string[];
}

export interface AdminModelUpdate {
  provider?: AdminLlmProvider | undefined;
  model?: string | undefined;
}

export interface ManagedFallbackExtractor extends FallbackRecipeExtractor {
  getState(): Promise<AdminModelState>;
  updateSettings(update: AdminModelUpdate): Promise<AdminModelState>;
  resetSettingsToEnv(): Promise<AdminModelState>;
}

export class AdminModelSettingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminModelSettingsValidationError";
  }
}

// Pricing changes frequently; values here mirror provider docs as of 2026-05-10.
export const adminModelCatalog: AdminModelOption[] = [
  {
    provider: "gemini",
    model: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash-Lite Preview",
    price: {
      inputUsdPerMillionTokens: 0.25,
      outputUsdPerMillionTokens: 1.5,
      source: "provider_docs",
      note: "Preview model."
    }
  },
  {
    provider: "gemini",
    model: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    price: {
      inputUsdPerMillionTokens: 0.5,
      outputUsdPerMillionTokens: 3,
      source: "provider_docs"
    }
  },
  {
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    price: {
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 12,
      source: "provider_docs",
      note: "Standard tier, prompts <= 200k tokens."
    }
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    price: {
      inputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 0.4,
      source: "provider_docs",
      note: "Standard tier."
    }
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    price: {
      inputUsdPerMillionTokens: 0.3,
      outputUsdPerMillionTokens: 2.5,
      source: "provider_docs",
      note: "Standard tier."
    }
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    price: {
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 10,
      source: "provider_docs",
      note: "Standard tier, prompts <= 200k tokens."
    }
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    label: "OpenAI GPT-5 mini",
    price: {
      inputUsdPerMillionTokens: 0.25,
      outputUsdPerMillionTokens: 2,
      source: "provider_docs"
    }
  },
  {
    provider: "openai",
    model: "gpt-5-nano",
    label: "OpenAI GPT-5 nano",
    price: {
      inputUsdPerMillionTokens: 0.05,
      outputUsdPerMillionTokens: 0.4,
      source: "provider_docs"
    }
  },
  {
    provider: "openai",
    model: "gpt-5.2",
    label: "OpenAI GPT-5.2",
    price: {
      inputUsdPerMillionTokens: 1.75,
      outputUsdPerMillionTokens: 14,
      source: "provider_docs"
    }
  },
  {
    provider: "openai",
    model: "gpt-5.2-chat-latest",
    label: "OpenAI GPT-5.2 Chat",
    price: {
      inputUsdPerMillionTokens: 1.75,
      outputUsdPerMillionTokens: 14,
      source: "provider_docs"
    }
  },
  {
    provider: "openai",
    model: "gpt-5.2-pro",
    label: "OpenAI GPT-5.2 Pro",
    price: {
      inputUsdPerMillionTokens: 21,
      outputUsdPerMillionTokens: 168,
      source: "provider_docs"
    }
  }
];

const normalizeModel = (value: string | null | undefined): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const getActiveModel = (settings: AdminModelSettings): string | null => {
  if (settings.selectedProvider === "gemini") {
    return settings.geminiModel;
  }

  if (settings.selectedProvider === "openai") {
    return settings.openAiModel;
  }

  return null;
};

const getProviderLabel = (provider: Exclude<AdminLlmProvider, "none">): string =>
  provider === "gemini" ? "Gemini" : "OpenAI";

export const getAdminCatalogWithModel = (
  provider: AdminLlmProvider,
  model: string | null,
  catalog: AdminModelOption[] = adminModelCatalog
): AdminModelOption[] => {
  if (provider === "none" || !model) {
    return catalog;
  }

  if (catalog.some((option) => option.provider === provider && option.model === model)) {
    return catalog;
  }

  return [
    ...catalog,
    {
      provider,
      model,
      label: `${getProviderLabel(provider)} ${model}`,
      price: {
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
        source: "unverified",
        note: "Configured active model; pricing is not in the local monitor catalog yet."
      }
    }
  ];
};

class RuntimeManagedFallbackExtractor implements ManagedFallbackExtractor {
  private settings: AdminModelSettings;
  private delegate: FallbackRecipeExtractor;
  private persistedSettingsLoadedAt: string | null = null;
  private persistedSettingsLoadError: string | null = null;
  private nextPersistedSettingsRefreshAt = 0;
  private hydratePromise: Promise<void> | null = null;
  private readonly persistedSettingsRefreshMs = 30_000;

  public constructor(private readonly fetchImplementation: typeof fetch) {
    this.settings = this.getEnvSettings();
    this.delegate = this.createDelegate();
  }

  private getEnvSettings(): AdminModelSettings {
    return {
      selectedProvider: extractorApiEnv.LLM_PROVIDER,
      geminiModel: normalizeModel(extractorApiEnv.GEMINI_MODEL),
      openAiModel: normalizeModel(extractorApiEnv.OPENAI_MODEL),
      updatedAt: null,
      updatedBy: "env",
      configSource: "env"
    };
  }

  public get available(): boolean {
    return this.delegate.available;
  }

  public get providerName(): FallbackRecipeExtractor["providerName"] {
    return this.delegate.providerName;
  }

  public async extract(...args: Parameters<FallbackRecipeExtractor["extract"]>) {
    await this.refreshPersistedSettings();
    return this.delegate.extract(...args);
  }

  public async getState(): Promise<AdminModelState> {
    await this.refreshPersistedSettings();

    return this.buildState();
  }

  private buildState(): AdminModelState {
    const notes: string[] = [];

    if (this.settings.selectedProvider === "gemini" && !extractorApiEnv.GEMINI_API_KEY) {
      notes.push("Gemini is selected, but GEMINI_API_KEY is not configured.");
    }

    if (this.settings.selectedProvider === "openai" && !extractorApiEnv.OPENAI_API_KEY) {
      notes.push("OpenAI is selected, but OPENAI_API_KEY is not configured.");
    }

    if (this.settings.selectedProvider !== "none" && !getActiveModel(this.settings)) {
      notes.push("The selected provider needs a model before LLM fallback can run.");
    }

    if (adminModelCatalog.some((model) => model.price.source === "unverified")) {
      notes.push("Some model prices need provider billing/API verification.");
    }

    if (!isAdminModelSettingsStoreConfigured()) {
      notes.push(
        "Runtime model persistence is not configured. Set Upstash Redis REST env vars before relying on admin model switches in production."
      );
    }

    if (this.persistedSettingsLoadError) {
      notes.push(`Could not refresh persisted model settings: ${this.persistedSettingsLoadError}`);
    }

    return {
      ...this.settings,
      runtimeProvider: this.delegate.providerName,
      available: this.delegate.available,
      activeModel: getActiveModel(this.settings),
      credentials: {
        gemini: Boolean(extractorApiEnv.GEMINI_API_KEY),
        openai: Boolean(extractorApiEnv.OPENAI_API_KEY)
      },
      catalog: getAdminCatalogWithModel(
        this.settings.selectedProvider,
        getActiveModel(this.settings)
      ),
      persistence: {
        configured: isAdminModelSettingsStoreConfigured(),
        key: getAdminModelSettingsKey(),
        lastLoadedAt: this.persistedSettingsLoadedAt,
        loadError: this.persistedSettingsLoadError
      },
      notes
    };
  }

  public async updateSettings(update: AdminModelUpdate): Promise<AdminModelState> {
    const nextProvider = update.provider ?? this.settings.selectedProvider;

    if (!["gemini", "openai", "none"].includes(nextProvider)) {
      throw new Error("Unsupported LLM provider.");
    }

    this.assertProviderCanRun(nextProvider);

    const nextModel = normalizeModel(update.model);
    const providerWasSpecified = update.provider !== undefined;

    if (providerWasSpecified && nextProvider !== "none" && !nextModel) {
      throw new AdminModelSettingsValidationError(
        "Selecting an LLM provider requires an explicit model."
      );
    }

    const nextSettings: AdminModelSettings = {
      ...this.settings,
      selectedProvider: nextProvider,
      updatedAt: new Date().toISOString(),
      updatedBy: "admin",
      configSource: "persisted"
    };

    if (nextProvider === "gemini") {
      nextSettings.geminiModel = nextModel ?? nextSettings.geminiModel;
    }

    if (nextProvider === "openai") {
      nextSettings.openAiModel = nextModel ?? nextSettings.openAiModel;
    }

    if (nextProvider !== "none" && !getActiveModel(nextSettings)) {
      throw new AdminModelSettingsValidationError(
        "The selected LLM provider does not have an active model."
      );
    }

    const persistedSettings = await writePersistedAdminModelSettings({
      provider: nextSettings.selectedProvider,
      model: getActiveModel(nextSettings)
    });

    this.settings = this.applyPersistedSettings(nextSettings, persistedSettings.updatedAt);
    this.delegate = this.createDelegate();
    this.persistedSettingsLoadedAt = new Date().toISOString();
    this.persistedSettingsLoadError = null;
    this.nextPersistedSettingsRefreshAt = Date.now() + this.persistedSettingsRefreshMs;

    return this.buildState();
  }

  public async resetSettingsToEnv(): Promise<AdminModelState> {
    await deletePersistedAdminModelSettings();

    this.settings = this.getEnvSettings();
    this.delegate = this.createDelegate();
    this.persistedSettingsLoadedAt = new Date().toISOString();
    this.persistedSettingsLoadError = null;
    this.nextPersistedSettingsRefreshAt = Date.now() + this.persistedSettingsRefreshMs;

    return this.buildState();
  }

  private assertProviderCanRun(provider: AdminLlmProvider): void {
    if (provider === "gemini" && !extractorApiEnv.GEMINI_API_KEY) {
      throw new AdminModelSettingsValidationError(
        "Gemini cannot be selected because GEMINI_API_KEY is not configured."
      );
    }

    if (provider === "openai" && !extractorApiEnv.OPENAI_API_KEY) {
      throw new AdminModelSettingsValidationError(
        "OpenAI cannot be selected because OPENAI_API_KEY is not configured."
      );
    }
  }

  private applyPersistedSettings(
    settings: AdminModelSettings,
    updatedAt: string | null
  ): AdminModelSettings {
    return {
      ...settings,
      updatedAt,
      updatedBy: "admin",
      configSource: "persisted"
    };
  }

  private async refreshPersistedSettings(): Promise<void> {
    if (!isAdminModelSettingsStoreConfigured()) {
      return;
    }

    if (Date.now() < this.nextPersistedSettingsRefreshAt) {
      return;
    }

    if (!this.hydratePromise) {
      this.hydratePromise = this.loadPersistedSettings().finally(() => {
        this.hydratePromise = null;
      });
    }

    await this.hydratePromise;
  }

  private async loadPersistedSettings(): Promise<void> {
    this.nextPersistedSettingsRefreshAt = Date.now() + this.persistedSettingsRefreshMs;

    try {
      const persistedSettings = await readPersistedAdminModelSettings();

      if (!persistedSettings) {
        this.persistedSettingsLoadedAt = new Date().toISOString();
        this.persistedSettingsLoadError = null;
        return;
      }

      const nextSettings: AdminModelSettings = {
        ...this.getEnvSettings(),
        selectedProvider: persistedSettings.provider,
        updatedAt: persistedSettings.updatedAt,
        updatedBy: "admin",
        configSource: "persisted"
      };

      if (persistedSettings.provider === "gemini") {
        nextSettings.geminiModel = normalizeModel(persistedSettings.model);
      }

      if (persistedSettings.provider === "openai") {
        nextSettings.openAiModel = normalizeModel(persistedSettings.model);
      }

      this.settings = nextSettings;
      this.delegate = this.createDelegate();
      this.persistedSettingsLoadedAt = new Date().toISOString();
      this.persistedSettingsLoadError = null;
    } catch (error) {
      this.persistedSettingsLoadError = error instanceof Error ? error.message : "Unknown error";
    }
  }

  private createDelegate(): FallbackRecipeExtractor {
    return createFallbackExtractor({
      provider: this.settings.selectedProvider,
      geminiApiKey: extractorApiEnv.GEMINI_API_KEY,
      geminiModel: this.settings.geminiModel ?? undefined,
      openAiApiKey: extractorApiEnv.OPENAI_API_KEY,
      openAiModel: this.settings.openAiModel ?? undefined,
      fetchImplementation: this.fetchImplementation,
      timeoutMs: extractorApiEnv.LLM_FALLBACK_TIMEOUT_MS
    });
  }
}

let sharedManagedFallbackExtractor: ManagedFallbackExtractor | null = null;

export const getSharedManagedFallbackExtractor = (
  fetchImplementation: typeof fetch
): ManagedFallbackExtractor => {
  if (!sharedManagedFallbackExtractor) {
    sharedManagedFallbackExtractor = new RuntimeManagedFallbackExtractor(fetchImplementation);
  }

  return sharedManagedFallbackExtractor;
};

export const isManagedFallbackExtractor = (
  fallbackExtractor: FallbackRecipeExtractor
): fallbackExtractor is ManagedFallbackExtractor =>
  "getState" in fallbackExtractor && "updateSettings" in fallbackExtractor;
