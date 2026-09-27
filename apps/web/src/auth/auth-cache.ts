import { accountUserSchema, authConfigResponseSchema } from "@linkdish/api-contracts";

import { safeGetItem, safeRemoveItem, safeSetItem } from "../platform/safe-storage";

import type { AccountUser, AuthConfigResponse } from "@linkdish/api-contracts";

/**
 * Stale-while-revalidate cache for auth boot. The last `/auth/config` answer and the last known
 * signed-in user are kept in localStorage so the app can render the right auth state instantly and
 * offline, then revalidate in the background.
 */

export const AUTH_CONFIG_CACHE_KEY = "linkdish:web:auth-config:v1";
export const AUTH_USER_CACHE_KEY = "linkdish:web:auth-user:v1";

export type CachedAuthUserSource = "clerk" | "legacy";

export interface CachedAuthConfig {
  config: AuthConfigResponse;
  savedAt: string;
}

export interface CachedAuthUser {
  savedAt: string;
  source: CachedAuthUserSource;
  user: AccountUser;
}

const readJson = (key: string): unknown => {
  const raw = safeGetItem(key);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

const readSavedAt = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const savedAt = (value as { savedAt?: unknown }).savedAt;
  return typeof savedAt === "string" ? savedAt : null;
};

export function readCachedAuthConfig(): CachedAuthConfig | null {
  const value = readJson(AUTH_CONFIG_CACHE_KEY);
  const savedAt = readSavedAt(value);
  const parsed = authConfigResponseSchema.safeParse((value as { config?: unknown } | null)?.config);

  if (!savedAt || !parsed.success) {
    return null;
  }

  return { config: parsed.data, savedAt };
}

export function writeCachedAuthConfig(config: AuthConfigResponse): void {
  const entry: CachedAuthConfig = { config, savedAt: new Date().toISOString() };
  safeSetItem(AUTH_CONFIG_CACHE_KEY, JSON.stringify(entry));
}

export function readCachedAuthUser(): CachedAuthUser | null {
  const value = readJson(AUTH_USER_CACHE_KEY);
  const savedAt = readSavedAt(value);

  if (!savedAt || typeof value !== "object" || value === null) {
    return null;
  }

  const source = (value as { source?: unknown }).source;
  const parsed = accountUserSchema.safeParse((value as { user?: unknown }).user);

  if (!parsed.success || (source !== "clerk" && source !== "legacy")) {
    return null;
  }

  return { savedAt, source, user: parsed.data };
}

export function writeCachedAuthUser(user: AccountUser, source: CachedAuthUserSource): void {
  const entry: CachedAuthUser = { savedAt: new Date().toISOString(), source, user };
  safeSetItem(AUTH_USER_CACHE_KEY, JSON.stringify(entry));
}

export function clearCachedAuthUser(): void {
  safeRemoveItem(AUTH_USER_CACHE_KEY);
}

/**
 * Whether the last known signed-in user had an unlimited-saves plan. Used as a fallback by local
 * quota checks whose callers do not pass the plan explicitly.
 */
export function isCachedUserPremium(): boolean {
  const plan = readCachedAuthUser()?.user.billingPlan;
  return plan === "plus" || plan === "family";
}
