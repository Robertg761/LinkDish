import { getWebAnalyticsSessionId } from "../analytics/session";
import { getStableClientId } from "../platform/stable-client-id";

import { apiBaseUrl } from "./base-url";
import { ExtractorApiError, toWebApiError } from "./errors";

import type { ExtractorApiClient } from "@linkdish/api-client";

export { apiBaseUrl, ExtractorApiError };
export { isExtractorApiError } from "./errors";

let getAuthTokenFn: (() => Promise<string | null> | string | null) | null = null;

export function registerAuthTokenProvider(provider: () => Promise<string | null> | string | null) {
  getAuthTokenFn = provider;
}

/** Headers every API request carries (identity, platform, session and auth). */
export async function buildApiRequestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "x-linkdish-client-id": getStableClientId(),
    "x-linkdish-platform": "web_app",
    "x-linkdish-session-id": getWebAnalyticsSessionId()
  };

  if (getAuthTokenFn) {
    const token = await getAuthTokenFn();
    if (token) {
      headers["authorization"] = `Bearer ${token}`;
    }
  }

  return headers;
}

/*
 * The real client (and the zod contracts it validates with) lives in its own chunk, loaded on
 * the first request instead of blocking the first render. Every method already returns a
 * promise, so callers do not notice; validation errors also become rejections instead of
 * synchronous throws.
 */

let realClientPromise: Promise<ExtractorApiClient> | null = null;

const loadRealClient = (): Promise<ExtractorApiClient> => {
  if (!realClientPromise) {
    const loading = import("@linkdish/api-client").then(({ createExtractorApiClient }) =>
      createExtractorApiClient({ baseUrl: apiBaseUrl, getHeaders: buildApiRequestHeaders })
    );
    realClientPromise = loading;
    // A failed chunk load (flaky network, new deploy) must not poison every later request.
    loading.catch(() => {
      if (realClientPromise === loading) {
        realClientPromise = null;
      }
    });
  }

  return realClientPromise;
};

/** Starts downloading the API client early (e.g. at boot). Never rejects. */
export const preloadApiClient = (): Promise<void> =>
  loadRealClient().then(
    () => undefined,
    () => undefined
  );

const API_METHODS = [
  "acceptHouseholdInvite",
  "cancelHouseholdInvite",
  "createHousehold",
  "createHouseholdInvite",
  "createSharedRecipe",
  "createWebBillingCheckout",
  "createWebBillingPortal",
  "deleteAccount",
  "deleteSharedRecipe",
  "deleteShoppingItems",
  "extractRecipe",
  "extractRecipeFromText",
  "getAuthConfig",
  "getBillingUsage",
  "getHousehold",
  "getSession",
  "getSharedRecipes",
  "getShoppingList",
  "getWebBillingAvailability",
  "leaveHousehold",
  "logout",
  "removeHouseholdMember",
  "requestLoginCode",
  "sendAnalyticsEvents",
  "updateAccountProfile",
  "updateSharedRecipe",
  "upsertShoppingItems",
  "verifyLoginCode"
] as const satisfies ReadonlyArray<keyof ExtractorApiClient>;

// Compile-time guard: adding a method to ExtractorApiClient without listing it here fails typecheck.
type UnlistedApiMethod = Exclude<keyof ExtractorApiClient, (typeof API_METHODS)[number]>;
const everyApiMethodListed: [UnlistedApiMethod] extends [never] ? true : UnlistedApiMethod = true;
void everyApiMethodListed;

type AnyApiMethod = (...args: unknown[]) => Promise<unknown>;

const createLazyApiClient = (): ExtractorApiClient => {
  const client: Partial<Record<keyof ExtractorApiClient, AnyApiMethod>> = {};

  for (const method of API_METHODS) {
    client[method] = async (...args: unknown[]) => {
      try {
        const real = await loadRealClient();
        return await (real[method] as unknown as AnyApiMethod).apply(real, args);
      } catch (error) {
        throw toWebApiError(error);
      }
    };
  }

  return client as unknown as ExtractorApiClient;
};

export const apiClient: ExtractorApiClient = createLazyApiClient();

export type { ExtractRecipeResponse } from "@linkdish/api-contracts";
export type { Recipe } from "@linkdish/recipe-domain";
export type { WebSavedRecipe } from "../features/library/saved-recipe-types";
