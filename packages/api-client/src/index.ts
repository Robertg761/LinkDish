import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  analyticsEventBatchRequestSchema,
  analyticsEventBatchResponseSchema,
  authConfigResponseSchema,
  authSessionResponseSchema,
  cancelInviteRequestSchema,
  createWebBillingCheckoutRequestSchema,
  createHouseholdResponseSchema,
  createInviteRequestSchema,
  createInviteResponseSchema,
  deleteShoppingItemsRequestSchema,
  deleteShoppingItemsResponseSchema,
  deleteSharedRecipeResponseSchema,
  deleteAccountRequestSchema,
  deleteAccountResponseSchema,
  extractRecipeRequestSchema,
  extractRecipeResponseSchema,
  householdMutationResponseSchema,
  householdShoppingListResponseSchema,
  householdSummarySchema,
  logoutResponseSchema,
  removeHouseholdMemberRequestSchema,
  requestLoginCodeRequestSchema,
  requestLoginCodeResponseSchema,
  sharedRecipeListResponseSchema,
  sharedRecipeResponseSchema,
  updateAccountProfileRequestSchema,
  updateAccountProfileResponseSchema,
  updateSharedRecipeRequestSchema,
  upsertShoppingItemsRequestSchema,
  upsertShoppingItemsResponseSchema,
  upsertSharedRecipeRequestSchema,
  verifyLoginCodeRequestSchema,
  verifyLoginCodeResponseSchema,
  webBillingAvailabilitySchema,
  webBillingRedirectResponseSchema,
  type AcceptInviteRequest,
  type AcceptInviteResponse,
  type AnalyticsEventBatchRequest,
  type AnalyticsEventBatchResponse,
  type AuthConfigResponse,
  type AuthSessionResponse,
  type CancelInviteRequest,
  type CreateWebBillingCheckoutRequest,
  type CreateHouseholdResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type DeleteShoppingItemsRequest,
  type DeleteShoppingItemsResponse,
  type DeleteSharedRecipeResponse,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type ExtractRecipeRequest,
  type ExtractRecipeResponse,
  type HouseholdMutationResponse,
  type HouseholdShoppingListResponse,
  type HouseholdSummary,
  type LogoutResponse,
  type RemoveHouseholdMemberRequest,
  type RequestLoginCodeRequest,
  type RequestLoginCodeResponse,
  type SharedRecipeListResponse,
  type SharedRecipeResponse,
  type UpdateAccountProfileRequest,
  type UpdateAccountProfileResponse,
  type UpdateSharedRecipeRequest,
  type UpsertShoppingItemsRequest,
  type UpsertShoppingItemsResponse,
  type UpsertSharedRecipeRequest,
  type VerifyLoginCodeRequest,
  type VerifyLoginCodeResponse,
  type WebBillingAvailability,
  type WebBillingRedirectResponse
} from "@linkdish/api-contracts";

import type { ZodType, ZodTypeDef } from "zod";

export type FetchLike = typeof fetch;

export class ExtractorApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ExtractorApiError";
  }
}

export interface ExtractorApiClient {
  acceptHouseholdInvite(input: AcceptInviteRequest): Promise<AcceptInviteResponse>;
  cancelHouseholdInvite(input: CancelInviteRequest): Promise<HouseholdMutationResponse>;
  createWebBillingCheckout(
    input: CreateWebBillingCheckoutRequest
  ): Promise<WebBillingRedirectResponse>;
  createWebBillingPortal(): Promise<WebBillingRedirectResponse>;
  createHousehold(): Promise<CreateHouseholdResponse>;
  createHouseholdInvite(input: CreateInviteRequest): Promise<CreateInviteResponse>;
  createSharedRecipe(input: UpsertSharedRecipeRequest): Promise<SharedRecipeResponse>;
  deleteAccount(input: DeleteAccountRequest): Promise<DeleteAccountResponse>;
  deleteShoppingItems(input: DeleteShoppingItemsRequest): Promise<DeleteShoppingItemsResponse>;
  deleteSharedRecipe(id: string): Promise<DeleteSharedRecipeResponse>;
  extractRecipe(input: ExtractRecipeRequest): Promise<ExtractRecipeResponse>;
  getAuthConfig(): Promise<AuthConfigResponse>;
  getWebBillingAvailability(): Promise<WebBillingAvailability>;
  getHousehold(): Promise<HouseholdSummary>;
  getSession(): Promise<AuthSessionResponse>;
  getSharedRecipes(): Promise<SharedRecipeListResponse>;
  getShoppingList(): Promise<HouseholdShoppingListResponse>;
  leaveHousehold(): Promise<HouseholdMutationResponse>;
  logout(): Promise<LogoutResponse>;
  removeHouseholdMember(input: RemoveHouseholdMemberRequest): Promise<HouseholdMutationResponse>;
  requestLoginCode(input: RequestLoginCodeRequest): Promise<RequestLoginCodeResponse>;
  sendAnalyticsEvents(input: AnalyticsEventBatchRequest): Promise<AnalyticsEventBatchResponse>;
  updateAccountProfile(input: UpdateAccountProfileRequest): Promise<UpdateAccountProfileResponse>;
  updateSharedRecipe(id: string, input: UpdateSharedRecipeRequest): Promise<SharedRecipeResponse>;
  upsertShoppingItems(input: UpsertShoppingItemsRequest): Promise<UpsertShoppingItemsResponse>;
  verifyLoginCode(input: VerifyLoginCodeRequest): Promise<VerifyLoginCodeResponse>;
}

export interface CreateExtractorApiClientOptions {
  baseUrl: string;
  fetchImplementation?: FetchLike;
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
}

export const createExtractorApiClient = ({
  baseUrl,
  fetchImplementation = fetch,
  getHeaders
}: CreateExtractorApiClientOptions): ExtractorApiClient => {
  let normalizedBaseUrl = baseUrl;

  while (normalizedBaseUrl.endsWith("/")) {
    normalizedBaseUrl = normalizedBaseUrl.slice(0, -1);
  }

  const requestJson = async <Response>(
    path: string,
    options: {
      body?: unknown;
      method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
      responseSchema: ZodType<Response, ZodTypeDef, unknown>;
    }
  ): Promise<Response> => {
    const response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(getHeaders ? await getHeaders() : {})
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });

    const rawBody = await response.text();
    let body: unknown;

    try {
      body = rawBody ? (JSON.parse(rawBody) as unknown) : null;
    } catch {
      body = rawBody;
    }

    const parsedBody = options.responseSchema.safeParse(body);

    if (parsedBody.success) {
      return parsedBody.data;
    }

    if (!response.ok) {
      throw new ExtractorApiError("Extractor API request failed.", response.status, body);
    }

    throw new ExtractorApiError(
      "Extractor API response did not match the contract.",
      response.status,
      body
    );
  };

  return {
    acceptHouseholdInvite(input) {
      return requestJson("/household/invites/accept", {
        body: acceptInviteRequestSchema.parse(input),
        method: "POST",
        responseSchema: acceptInviteResponseSchema
      });
    },
    cancelHouseholdInvite(input) {
      const request = cancelInviteRequestSchema.parse(input);

      return requestJson(`/household/invites/${encodeURIComponent(request.inviteId)}`, {
        method: "DELETE",
        responseSchema: householdMutationResponseSchema
      });
    },
    createWebBillingCheckout(input) {
      return requestJson("/billing/checkout", {
        body: createWebBillingCheckoutRequestSchema.parse(input),
        method: "POST",
        responseSchema: webBillingRedirectResponseSchema
      });
    },
    createWebBillingPortal() {
      return requestJson("/billing/portal", {
        method: "POST",
        responseSchema: webBillingRedirectResponseSchema
      });
    },
    createHousehold() {
      return requestJson("/household", {
        method: "POST",
        responseSchema: createHouseholdResponseSchema
      });
    },
    createHouseholdInvite(input) {
      return requestJson("/household/invites", {
        body: createInviteRequestSchema.parse(input),
        method: "POST",
        responseSchema: createInviteResponseSchema
      });
    },
    createSharedRecipe(input) {
      return requestJson("/household/recipes", {
        body: upsertSharedRecipeRequestSchema.parse(input),
        method: "POST",
        responseSchema: sharedRecipeResponseSchema
      });
    },
    deleteAccount(input) {
      return requestJson("/account", {
        body: deleteAccountRequestSchema.parse(input),
        method: "DELETE",
        responseSchema: deleteAccountResponseSchema
      });
    },
    deleteShoppingItems(input) {
      return requestJson("/household/shopping/items", {
        body: deleteShoppingItemsRequestSchema.parse(input),
        method: "DELETE",
        responseSchema: deleteShoppingItemsResponseSchema
      });
    },
    deleteSharedRecipe(id) {
      return requestJson(`/household/recipes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        responseSchema: deleteSharedRecipeResponseSchema
      });
    },
    async extractRecipe(input) {
      const request = extractRecipeRequestSchema.parse(input);
      const response = await fetchImplementation(`${normalizedBaseUrl}/extract`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(getHeaders ? await getHeaders() : {})
        },
        body: JSON.stringify(request)
      });

      const rawBody = await response.text();
      let body: unknown;

      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        body = rawBody;
      }

      const parsedBody = extractRecipeResponseSchema.safeParse(body);

      if (parsedBody.success) {
        return parsedBody.data;
      }

      if (!response.ok) {
        throw new ExtractorApiError("Extractor API request failed.", response.status, body);
      }

      throw new ExtractorApiError(
        "Extractor API response did not match the contract.",
        response.status,
        body
      );
    },
    getAuthConfig() {
      return requestJson("/auth/config", {
        responseSchema: authConfigResponseSchema
      });
    },
    getWebBillingAvailability() {
      return requestJson("/billing/config", {
        responseSchema: webBillingAvailabilitySchema
      });
    },
    getHousehold() {
      return requestJson("/household", {
        responseSchema: householdSummarySchema
      });
    },
    getSession() {
      return requestJson("/auth/session", {
        responseSchema: authSessionResponseSchema
      });
    },
    getSharedRecipes() {
      return requestJson("/household/recipes", {
        responseSchema: sharedRecipeListResponseSchema
      });
    },
    getShoppingList() {
      return requestJson("/household/shopping", {
        responseSchema: householdShoppingListResponseSchema
      });
    },
    leaveHousehold() {
      return requestJson("/household/leave", {
        method: "POST",
        responseSchema: householdMutationResponseSchema
      });
    },
    logout() {
      return requestJson("/auth/logout", {
        method: "POST",
        responseSchema: logoutResponseSchema
      });
    },
    removeHouseholdMember(input) {
      return requestJson("/household/members/remove", {
        body: removeHouseholdMemberRequestSchema.parse(input),
        method: "POST",
        responseSchema: householdMutationResponseSchema
      });
    },
    requestLoginCode(input) {
      return requestJson("/auth/login-code", {
        body: requestLoginCodeRequestSchema.parse(input),
        method: "POST",
        responseSchema: requestLoginCodeResponseSchema
      });
    },
    sendAnalyticsEvents(input) {
      return requestJson("/analytics/events", {
        body: analyticsEventBatchRequestSchema.parse(input),
        method: "POST",
        responseSchema: analyticsEventBatchResponseSchema
      });
    },
    updateAccountProfile(input) {
      return requestJson("/account", {
        body: updateAccountProfileRequestSchema.parse(input),
        method: "PATCH",
        responseSchema: updateAccountProfileResponseSchema
      });
    },
    updateSharedRecipe(id, input) {
      return requestJson(`/household/recipes/${encodeURIComponent(id)}`, {
        body: updateSharedRecipeRequestSchema.parse(input),
        method: "PATCH",
        responseSchema: sharedRecipeResponseSchema
      });
    },
    upsertShoppingItems(input) {
      return requestJson("/household/shopping/items", {
        body: upsertShoppingItemsRequestSchema.parse(input),
        method: "PUT",
        responseSchema: upsertShoppingItemsResponseSchema
      });
    },
    verifyLoginCode(input) {
      return requestJson("/auth/verify-code", {
        body: verifyLoginCodeRequestSchema.parse(input),
        method: "POST",
        responseSchema: verifyLoginCodeResponseSchema
      });
    }
  };
};
