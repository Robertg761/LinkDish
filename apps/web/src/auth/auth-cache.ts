import { safeGetItem, safeRemoveItem, safeSetItem } from "../platform/safe-storage";

import type { AccountUser, AuthConfigResponse } from "@linkdish/api-contracts";

// Validated by hand (not with the zod contracts) so auth boot stays out of the zod chunk.

const AUTH_MODES: ReadonlyArray<AuthConfigResponse["authMode"]> = [
  "legacy_email_code",
  "clerk_beta",
  "clerk_primary"
];
const BILLING_PLANS: ReadonlyArray<NonNullable<AccountUser["billingPlan"]>> = [
  "free",
  "plus",
  "family"
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalText = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string";

const parseAuthConfig = (value: unknown): AuthConfigResponse | null => {
  if (
    !isRecord(value) ||
    !AUTH_MODES.includes(value.authMode as AuthConfigResponse["authMode"]) ||
    typeof value.clerkEnabled !== "boolean" ||
    typeof value.emailCodeEnabled !== "boolean"
  ) {
    return null;
  }

  return {
    authMode: value.authMode as AuthConfigResponse["authMode"],
    clerkEnabled: value.clerkEnabled,
    emailCodeEnabled: value.emailCodeEnabled
  };
};

const parseAccountUser = (value: unknown): AccountUser | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.email !== "string" ||
    !value.email.includes("@") ||
    (value.billingPlan !== undefined &&
      !BILLING_PLANS.includes(value.billingPlan as NonNullable<AccountUser["billingPlan"]>)) ||
    !isOptionalText(value.displayName) ||
    !isOptionalText(value.avatarEmoji)
  ) {
    return null;
  }

  return {
    email: value.email,
    id: value.id,
    ...(value.billingPlan !== undefined
      ? { billingPlan: value.billingPlan as NonNullable<AccountUser["billingPlan"]> }
      : {}),
    ...(value.displayName !== undefined ? { displayName: value.displayName } : {}),
    ...(value.avatarEmoji !== undefined ? { avatarEmoji: value.avatarEmoji } : {})
  };
};

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
  /**
   * The Clerk session the API confirmed this user for. Shown at boot only while Clerk is still
   * on that session: another session may be another account's.
   */
  clerkSessionId?: string | undefined;
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
  const config = parseAuthConfig((value as { config?: unknown } | null)?.config);

  if (!savedAt || !config) {
    return null;
  }

  return { config, savedAt };
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
  const user = parseAccountUser((value as { user?: unknown }).user);

  if (!user || (source !== "clerk" && source !== "legacy")) {
    return null;
  }

  const clerkSessionId = (value as { clerkSessionId?: unknown }).clerkSessionId;

  return {
    ...(typeof clerkSessionId === "string" && clerkSessionId ? { clerkSessionId } : {}),
    savedAt,
    source,
    user
  };
}

export function writeCachedAuthUser(
  user: AccountUser,
  source: CachedAuthUserSource,
  clerkSessionId?: string | null
): void {
  const entry: CachedAuthUser = {
    ...(clerkSessionId ? { clerkSessionId } : {}),
    savedAt: new Date().toISOString(),
    source,
    user
  };
  safeSetItem(AUTH_USER_CACHE_KEY, JSON.stringify(entry));
}

export function clearCachedAuthUser(): void {
  safeRemoveItem(AUTH_USER_CACHE_KEY);
}

/**
 * Set while a sign-out still has to reach Clerk: the user signed out before Clerk had loaded (or
 * Clerk's sign-out failed). Until Clerk confirms it, Clerk loading must not sign them back in.
 */
export const CLERK_SIGN_OUT_PENDING_KEY = "linkdish:web:clerk-sign-out:v1";

export function markClerkSignOutPending(): void {
  safeSetItem(CLERK_SIGN_OUT_PENDING_KEY, new Date().toISOString());
}

export function clearClerkSignOutPending(): void {
  safeRemoveItem(CLERK_SIGN_OUT_PENDING_KEY);
}

export function isClerkSignOutPending(): boolean {
  return safeGetItem(CLERK_SIGN_OUT_PENDING_KEY) !== null;
}

/**
 * Whether the last known signed-in user had an unlimited-saves plan. Used as a fallback by local
 * quota checks whose callers do not pass the plan explicitly.
 */
export function isCachedUserPremium(): boolean {
  const plan = readCachedAuthUser()?.user.billingPlan;
  return plan === "plus" || plan === "family";
}
