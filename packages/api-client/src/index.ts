import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  analyticsEventBatchRequestSchema,
  analyticsEventBatchResponseSchema,
  authConfigResponseSchema,
  authSessionResponseSchema,
  billingUsageResponseSchema,
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
  extractRecipeTextRequestSchema,
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
  type BillingUsageResponse,
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
  type ExtractRecipeTextRequestInput,
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

/**
 * What went wrong with an API call:
 * - "network": no response arrived (offline, DNS, CORS, connection reset). `statusCode` is 0.
 * - "timeout": the client-side timeout fired before a response arrived. `statusCode` is 0.
 * - "http": the API answered with a non-2xx status. `serverMessage` carries `body.message`.
 * - "contract": a 2xx response did not match the shared contract (version skew or a proxy page).
 * - "validation": the request input was invalid, so nothing was sent. `statusCode` is 0 and
 *   `details` holds the zod issues.
 */
export type ExtractorApiErrorKind = "network" | "timeout" | "http" | "contract" | "validation";

export interface ExtractorApiErrorOptions {
  /** Defaults to "http", which is what every error was before kinds existed. */
  kind?: ExtractorApiErrorKind | undefined;
  /** Defaults to `details.message` when the response body carried one. */
  serverMessage?: string | undefined;
  cause?: unknown;
}

const readServerMessage = (details: unknown): string | undefined => {
  if (!details || typeof details !== "object" || !("message" in details)) {
    return undefined;
  }

  const { message } = details as { message?: unknown };

  return typeof message === "string" && message.trim().length > 0 ? message : undefined;
};

export class ExtractorApiError extends Error {
  public readonly kind: ExtractorApiErrorKind;
  /** The API's own `message` from the error body, when it sent one. */
  public readonly serverMessage: string | undefined;

  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
    options: ExtractorApiErrorOptions = {}
  ) {
    super(message);
    this.name = "ExtractorApiError";

    // Set by hand: `new Error(message, { cause })` needs an ES2022 lib the apps may not target.
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true
      });
    }

    this.kind = options.kind ?? "http";
    this.serverMessage = options.serverMessage ?? readServerMessage(details);
  }
}

export const isExtractorApiError = (error: unknown): error is ExtractorApiError =>
  error instanceof ExtractorApiError;

/** Per-call options accepted by every client method. */
export interface ExtractorApiRequestOptions {
  /**
   * Cancels the request. It is combined with the client timeout; a caller abort rejects with
   * the signal's reason (an `AbortError` by default), not with an `ExtractorApiError`.
   */
  signal?: AbortSignal | undefined;
}

type RequestOptionsArgument = ExtractorApiRequestOptions | undefined;

export interface ExtractorApiClient {
  acceptHouseholdInvite(
    input: AcceptInviteRequest,
    options?: RequestOptionsArgument
  ): Promise<AcceptInviteResponse>;
  cancelHouseholdInvite(
    input: CancelInviteRequest,
    options?: RequestOptionsArgument
  ): Promise<HouseholdMutationResponse>;
  createWebBillingCheckout(
    input: CreateWebBillingCheckoutRequest,
    options?: RequestOptionsArgument
  ): Promise<WebBillingRedirectResponse>;
  createWebBillingPortal(options?: RequestOptionsArgument): Promise<WebBillingRedirectResponse>;
  createHousehold(options?: RequestOptionsArgument): Promise<CreateHouseholdResponse>;
  createHouseholdInvite(
    input: CreateInviteRequest,
    options?: RequestOptionsArgument
  ): Promise<CreateInviteResponse>;
  createSharedRecipe(
    input: UpsertSharedRecipeRequest,
    options?: RequestOptionsArgument
  ): Promise<SharedRecipeResponse>;
  deleteAccount(
    input: DeleteAccountRequest,
    options?: RequestOptionsArgument
  ): Promise<DeleteAccountResponse>;
  deleteShoppingItems(
    input: DeleteShoppingItemsRequest,
    options?: RequestOptionsArgument
  ): Promise<DeleteShoppingItemsResponse>;
  deleteSharedRecipe(
    id: string,
    options?: RequestOptionsArgument
  ): Promise<DeleteSharedRecipeResponse>;
  extractRecipe(
    input: ExtractRecipeRequest,
    options?: RequestOptionsArgument
  ): Promise<ExtractRecipeResponse>;
  /**
   * Imports a recipe from pasted text (20 to 20,000 characters). The API always uses its AI
   * extractor for text, so a success counts like an explicit fallback attempt for billing.
   */
  extractRecipeFromText(
    input: ExtractRecipeTextRequestInput,
    options?: RequestOptionsArgument
  ): Promise<ExtractRecipeResponse>;
  getAuthConfig(options?: RequestOptionsArgument): Promise<AuthConfigResponse>;
  /** The caller's current import allowance (GET /billing/usage), without counting an import. */
  getBillingUsage(options?: RequestOptionsArgument): Promise<BillingUsageResponse>;
  getWebBillingAvailability(options?: RequestOptionsArgument): Promise<WebBillingAvailability>;
  getHousehold(options?: RequestOptionsArgument): Promise<HouseholdSummary>;
  getSession(options?: RequestOptionsArgument): Promise<AuthSessionResponse>;
  getSharedRecipes(options?: RequestOptionsArgument): Promise<SharedRecipeListResponse>;
  getShoppingList(options?: RequestOptionsArgument): Promise<HouseholdShoppingListResponse>;
  leaveHousehold(options?: RequestOptionsArgument): Promise<HouseholdMutationResponse>;
  logout(options?: RequestOptionsArgument): Promise<LogoutResponse>;
  removeHouseholdMember(
    input: RemoveHouseholdMemberRequest,
    options?: RequestOptionsArgument
  ): Promise<HouseholdMutationResponse>;
  requestLoginCode(
    input: RequestLoginCodeRequest,
    options?: RequestOptionsArgument
  ): Promise<RequestLoginCodeResponse>;
  sendAnalyticsEvents(
    input: AnalyticsEventBatchRequest,
    options?: RequestOptionsArgument
  ): Promise<AnalyticsEventBatchResponse>;
  updateAccountProfile(
    input: UpdateAccountProfileRequest,
    options?: RequestOptionsArgument
  ): Promise<UpdateAccountProfileResponse>;
  updateSharedRecipe(
    id: string,
    input: UpdateSharedRecipeRequest,
    options?: RequestOptionsArgument
  ): Promise<SharedRecipeResponse>;
  upsertShoppingItems(
    input: UpsertShoppingItemsRequest,
    options?: RequestOptionsArgument
  ): Promise<UpsertShoppingItemsResponse>;
  verifyLoginCode(
    input: VerifyLoginCodeRequest,
    options?: RequestOptionsArgument
  ): Promise<VerifyLoginCodeResponse>;
}

/** A stalled mobile connection would otherwise hang forever, so every request is bounded. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Extraction can legitimately take a while (browser fallback, LLM passes), so it gets longer. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 120_000;

export interface CreateExtractorApiClientOptions {
  baseUrl: string;
  fetchImplementation?: FetchLike;
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Per-request timeout in milliseconds. Pass 0 (or a negative value) to disable. */
  timeoutMs?: number;
  /** Timeout for extraction requests specifically. Defaults to {@link DEFAULT_EXTRACT_TIMEOUT_MS}. */
  extractTimeoutMs?: number;
}

interface RequestSignal {
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  dispose: () => void;
}

const createAbortError = (): Error => {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
};

/* The caller's own cancellation reason, so `signal.reason` round-trips like it does with fetch. */
const callerAbortReason = (signal: AbortSignal): unknown =>
  (signal.reason as unknown) ?? createAbortError();

const unrefTimer = (timer: unknown): void => {
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
};

/*
 * One signal for the client timeout and the caller's signal. Built on AbortController and
 * setTimeout rather than AbortSignal.timeout/any, which React Native and older browsers lack.
 */
const createRequestSignal = (
  timeoutMs: number,
  callerSignal: AbortSignal | undefined
): RequestSignal => {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  if (typeof AbortController === "undefined") {
    return { signal: callerSignal, timedOut: () => false, dispose: () => undefined };
  }

  if (!hasTimeout && !callerSignal) {
    return { signal: undefined, timedOut: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let didTimeOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = () => {
    controller.abort(callerSignal ? callerAbortReason(callerSignal) : undefined);
  };

  if (hasTimeout) {
    timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort(new Error("Extractor API request timed out."));
    }, timeoutMs);
    unrefTimer(timer);
  }

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
};

const describeTransportError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;

type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

interface RequestJsonOptions<Response> {
  body?: unknown;
  method?: HttpMethod;
  responseSchema: ZodType<Response, ZodTypeDef, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

/** Validates request input; a failure becomes a "validation" ExtractorApiError. */
const validateInput = <Output>(schema: ZodType<Output, ZodTypeDef, unknown>, input: unknown) => {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new ExtractorApiError("Extractor API request input is invalid.", 0, parsed.error.issues, {
      kind: "validation",
      cause: parsed.error
    });
  }

  return parsed.data;
};

export const createExtractorApiClient = (
  options: CreateExtractorApiClientOptions
): ExtractorApiClient => {
  const { baseUrl, fetchImplementation = fetch, getHeaders } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // An explicit `timeoutMs` also bounds extraction unless a dedicated value is supplied.
  const extractTimeoutMs =
    options.extractTimeoutMs ?? options.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;

  let normalizedBaseUrl = baseUrl;

  while (normalizedBaseUrl.endsWith("/")) {
    normalizedBaseUrl = normalizedBaseUrl.slice(0, -1);
  }

  const requestJson = async <Response>(
    path: string,
    request: RequestJsonOptions<Response>
  ): Promise<Response> => {
    const callerSignal = request.signal;

    if (callerSignal?.aborted) {
      throw callerAbortReason(callerSignal);
    }

    const headers = {
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      ...(getHeaders ? await getHeaders() : {})
    };
    const requestSignal = createRequestSignal(request.timeoutMs ?? timeoutMs, callerSignal);

    let response: Awaited<ReturnType<FetchLike>>;
    let rawBody: string;

    try {
      response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
        method: request.method ?? "GET",
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(requestSignal.signal === undefined ? {} : { signal: requestSignal.signal })
      });

      rawBody = await response.text();
    } catch (error) {
      if (callerSignal?.aborted) {
        throw callerAbortReason(callerSignal);
      }

      if (requestSignal.timedOut()) {
        throw new ExtractorApiError("Extractor API request timed out.", 0, undefined, {
          kind: "timeout",
          cause: error
        });
      }

      // The original message is kept ("Network request failed", "Failed to fetch"): callers
      // already match on it.
      throw new ExtractorApiError(
        describeTransportError(error, "Extractor API request failed to send."),
        0,
        undefined,
        { kind: "network", cause: error }
      );
    } finally {
      requestSignal.dispose();
    }

    let body: unknown;

    try {
      body = rawBody ? (JSON.parse(rawBody) as unknown) : null;
    } catch {
      body = rawBody;
    }

    // An error response is an error even when its body happens to satisfy the success contract.
    if (!response.ok) {
      throw new ExtractorApiError("Extractor API request failed.", response.status, body, {
        kind: "http"
      });
    }

    const parsedBody = request.responseSchema.safeParse(body);

    if (parsedBody.success) {
      return parsedBody.data;
    }

    throw new ExtractorApiError(
      "Extractor API response did not match the contract.",
      response.status,
      body,
      { kind: "contract", cause: parsedBody.error }
    );
  };

  /*
   * Every method is async, so invalid input (including a thrown getHeaders) always surfaces as
   * a rejected promise, never as a synchronous throw from the call site.
   */
  return {
    async acceptHouseholdInvite(input, callOptions) {
      return requestJson("/household/invites/accept", {
        body: validateInput(acceptInviteRequestSchema, input),
        method: "POST",
        responseSchema: acceptInviteResponseSchema,
        signal: callOptions?.signal
      });
    },
    async cancelHouseholdInvite(input, callOptions) {
      const request = validateInput(cancelInviteRequestSchema, input);

      return requestJson(`/household/invites/${encodeURIComponent(request.inviteId)}`, {
        method: "DELETE",
        responseSchema: householdMutationResponseSchema,
        signal: callOptions?.signal
      });
    },
    async createWebBillingCheckout(input, callOptions) {
      return requestJson("/billing/checkout", {
        body: validateInput(createWebBillingCheckoutRequestSchema, input),
        method: "POST",
        responseSchema: webBillingRedirectResponseSchema,
        signal: callOptions?.signal
      });
    },
    async createWebBillingPortal(callOptions) {
      return requestJson("/billing/portal", {
        method: "POST",
        responseSchema: webBillingRedirectResponseSchema,
        signal: callOptions?.signal
      });
    },
    async createHousehold(callOptions) {
      return requestJson("/household", {
        method: "POST",
        responseSchema: createHouseholdResponseSchema,
        signal: callOptions?.signal
      });
    },
    async createHouseholdInvite(input, callOptions) {
      return requestJson("/household/invites", {
        body: validateInput(createInviteRequestSchema, input),
        method: "POST",
        responseSchema: createInviteResponseSchema,
        signal: callOptions?.signal
      });
    },
    async createSharedRecipe(input, callOptions) {
      return requestJson("/household/recipes", {
        body: validateInput(upsertSharedRecipeRequestSchema, input),
        method: "POST",
        responseSchema: sharedRecipeResponseSchema,
        signal: callOptions?.signal
      });
    },
    async deleteAccount(input, callOptions) {
      return requestJson("/account", {
        body: validateInput(deleteAccountRequestSchema, input),
        method: "DELETE",
        responseSchema: deleteAccountResponseSchema,
        signal: callOptions?.signal
      });
    },
    async deleteShoppingItems(input, callOptions) {
      return requestJson("/household/shopping/items", {
        body: validateInput(deleteShoppingItemsRequestSchema, input),
        method: "DELETE",
        responseSchema: deleteShoppingItemsResponseSchema,
        signal: callOptions?.signal
      });
    },
    async deleteSharedRecipe(id, callOptions) {
      return requestJson(`/household/recipes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        responseSchema: deleteSharedRecipeResponseSchema,
        signal: callOptions?.signal
      });
    },
    async extractRecipe(input, callOptions) {
      return requestJson("/extract", {
        body: validateInput(extractRecipeRequestSchema, input),
        method: "POST",
        responseSchema: extractRecipeResponseSchema,
        timeoutMs: extractTimeoutMs,
        signal: callOptions?.signal
      });
    },
    async extractRecipeFromText(input, callOptions) {
      return requestJson("/extract", {
        body: validateInput(extractRecipeTextRequestSchema, input),
        method: "POST",
        responseSchema: extractRecipeResponseSchema,
        timeoutMs: extractTimeoutMs,
        signal: callOptions?.signal
      });
    },
    async getAuthConfig(callOptions) {
      return requestJson("/auth/config", {
        responseSchema: authConfigResponseSchema,
        signal: callOptions?.signal
      });
    },
    async getBillingUsage(callOptions) {
      return requestJson("/billing/usage", {
        responseSchema: billingUsageResponseSchema,
        signal: callOptions?.signal
      });
    },
    async getWebBillingAvailability(callOptions) {
      return requestJson("/billing/config", {
        responseSchema: webBillingAvailabilitySchema,
        signal: callOptions?.signal
      });
    },
    async getHousehold(callOptions) {
      return requestJson("/household", {
        responseSchema: householdSummarySchema,
        signal: callOptions?.signal
      });
    },
    async getSession(callOptions) {
      return requestJson("/auth/session", {
        responseSchema: authSessionResponseSchema,
        signal: callOptions?.signal
      });
    },
    async getSharedRecipes(callOptions) {
      return requestJson("/household/recipes", {
        responseSchema: sharedRecipeListResponseSchema,
        signal: callOptions?.signal
      });
    },
    async getShoppingList(callOptions) {
      return requestJson("/household/shopping", {
        responseSchema: householdShoppingListResponseSchema,
        signal: callOptions?.signal
      });
    },
    async leaveHousehold(callOptions) {
      return requestJson("/household/leave", {
        method: "POST",
        responseSchema: householdMutationResponseSchema,
        signal: callOptions?.signal
      });
    },
    async logout(callOptions) {
      return requestJson("/auth/logout", {
        method: "POST",
        responseSchema: logoutResponseSchema,
        signal: callOptions?.signal
      });
    },
    async removeHouseholdMember(input, callOptions) {
      return requestJson("/household/members/remove", {
        body: validateInput(removeHouseholdMemberRequestSchema, input),
        method: "POST",
        responseSchema: householdMutationResponseSchema,
        signal: callOptions?.signal
      });
    },
    async requestLoginCode(input, callOptions) {
      return requestJson("/auth/login-code", {
        body: validateInput(requestLoginCodeRequestSchema, input),
        method: "POST",
        responseSchema: requestLoginCodeResponseSchema,
        signal: callOptions?.signal
      });
    },
    async sendAnalyticsEvents(input, callOptions) {
      return requestJson("/analytics/events", {
        body: validateInput(analyticsEventBatchRequestSchema, input),
        method: "POST",
        responseSchema: analyticsEventBatchResponseSchema,
        signal: callOptions?.signal
      });
    },
    async updateAccountProfile(input, callOptions) {
      return requestJson("/account", {
        body: validateInput(updateAccountProfileRequestSchema, input),
        method: "PATCH",
        responseSchema: updateAccountProfileResponseSchema,
        signal: callOptions?.signal
      });
    },
    async updateSharedRecipe(id, input, callOptions) {
      return requestJson(`/household/recipes/${encodeURIComponent(id)}`, {
        body: validateInput(updateSharedRecipeRequestSchema, input),
        method: "PATCH",
        responseSchema: sharedRecipeResponseSchema,
        signal: callOptions?.signal
      });
    },
    async upsertShoppingItems(input, callOptions) {
      return requestJson("/household/shopping/items", {
        body: validateInput(upsertShoppingItemsRequestSchema, input),
        method: "PUT",
        responseSchema: upsertShoppingItemsResponseSchema,
        signal: callOptions?.signal
      });
    },
    async verifyLoginCode(input, callOptions) {
      return requestJson("/auth/verify-code", {
        body: validateInput(verifyLoginCodeRequestSchema, input),
        method: "POST",
        responseSchema: verifyLoginCodeResponseSchema,
        signal: callOptions?.signal
      });
    }
  };
};
