import { createExtractorApiClient, type ExtractorApiClient } from "@linkdish/api-client";

import { getWebAnalyticsSessionId } from "../analytics/session";
import { getStableClientId } from "../platform/stable-client-id";

export const apiBaseUrl = (
  (import.meta.env.VITE_LINKDISH_API_BASE_URL as string | undefined) ||
  "https://api.linkdish.ca"
).replace(/\/+$/, "");

let getAuthTokenFn: (() => Promise<string | null> | string | null) | null = null;

export function registerAuthTokenProvider(provider: () => Promise<string | null> | string | null) {
  getAuthTokenFn = provider;
}

export const apiClient: ExtractorApiClient = createExtractorApiClient({
  baseUrl: apiBaseUrl,
  getHeaders: async () => {
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
});
export { ExtractorApiError } from "@linkdish/api-client";
export type { ExtractRecipeResponse } from "@linkdish/api-contracts";
export type { Recipe } from "@linkdish/recipe-domain";
export type { WebSavedRecipe } from "../features/library/saved-recipe-types";
