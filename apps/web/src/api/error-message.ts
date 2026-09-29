import { getApiErrorKind, isExtractorApiError } from "./errors";

/**
 * Plain-language copy for anything a request can throw: API errors (using the server's own
 * message when it reads like one written for people), timeouts, dropped connections and contract
 * mismatches. Never shows raw JSON, status codes or schema output.
 */

export type FriendlyErrorContext =
  | "generic"
  | "extract"
  | "save"
  | "load"
  | "sync"
  | "auth"
  | "billing"
  | "household"
  | "shopping"
  | "share";

const OFFLINE_MESSAGE = "You're offline. Check your connection and try again.";
const NETWORK_MESSAGE = "We couldn't reach LinkDish. Check your connection and try again.";
const TIMEOUT_MESSAGE = "That took too long to answer. Please try again in a moment.";
const RATE_LIMIT_MESSAGE =
  "That's a lot of requests at once. Take a breath and try again in a minute.";
const SERVER_MESSAGE = "LinkDish is having trouble right now. Please try again shortly.";
const UNEXPECTED_RESPONSE_MESSAGE = "We got an answer we didn't expect. Please try again.";

const contextFallbacks: Record<FriendlyErrorContext, string> = {
  auth: "We couldn't sign you in. Please try again.",
  billing: "We couldn't open billing right now. Please try again.",
  extract: "We couldn't read a recipe from that. Try another link, or paste the recipe text.",
  generic: "Something went wrong. Please try again.",
  household: "We couldn't update your household. Please try again.",
  load: "We couldn't load that. Please try again.",
  save: "We couldn't save that. Please try again.",
  share: "We couldn't share that. Please try again.",
  shopping: "We couldn't update your shopping list. Please try again.",
  sync: "We couldn't sync with your household. Your recipes are still saved on this device."
};

const notFoundMessages: Partial<Record<FriendlyErrorContext, string>> = {
  extract: "We couldn't find a recipe at that link. Check the address, or paste the recipe text.",
  household: "That household or invite is no longer available.",
  load: "We couldn't find that. It may have been removed.",
  share: "That shared recipe is no longer available.",
  sync: "The household copy of this recipe is no longer available."
};

/** True when the browser reports no network connection. */
export const isOffline = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;

const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";

const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message)
    : "";

/** Request timeouts (`AbortSignal.timeout`) and aborted requests. */
export const isTimeoutError = (error: unknown): boolean => {
  const name = errorName(error);
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timed out|timeout/iu.test(errorMessage(error))
  );
};

/** `fetch` rejections for dropped or refused connections. */
export const isNetworkError = (error: unknown): boolean =>
  error instanceof TypeError &&
  /fetch|network|load failed|connection/iu.test(error.message || "network");

const isZodError = (error: unknown): boolean =>
  errorName(error) === "ZodError" && Array.isArray((error as { issues?: unknown }).issues);

const DEVELOPER_JARGON =
  /\b(?:zod|schema|contract|payload|json|stack|undefined|null|nan|exception|internal|extractor|invalid [a-z ]*request|unexpected [a-z ]*error|status code|http \d{3})\b/iu;

/** A server message we'd be happy to show a cook as-is. */
const isPresentableMessage = (message: string): boolean =>
  message.length >= 8 &&
  message.length <= 200 &&
  !/[{}[\]<>]|=>|\\n/u.test(message) &&
  !DEVELOPER_JARGON.test(message);

/** The `message` the API put in an error body, when there is a presentable one. */
export const getServerErrorMessage = (error: unknown): string | null => {
  if (!isExtractorApiError(error)) {
    return null;
  }

  const details: unknown = error.details;
  let message: unknown = null;

  if (typeof details === "string") {
    message = details;
  } else if (details && typeof details === "object") {
    const record = details as Record<string, unknown>;
    message =
      typeof record.message === "string"
        ? record.message
        : record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>).message
          : typeof record.error === "string"
            ? record.error
            : null;
  }

  if (typeof message !== "string") {
    return null;
  }

  const trimmed = message.trim().replace(/\s+/gu, " ");
  return isPresentableMessage(trimmed) ? trimmed : null;
};

const messageForStatus = (status: number, context: FriendlyErrorContext): string | null => {
  if (status === 401) {
    return context === "auth"
      ? "That sign-in didn't work. Please try again."
      : "Please sign in again to continue.";
  }

  if (status === 403) {
    return context === "household" || context === "sync" || context === "share"
      ? "This needs an active Family household."
      : "You don't have access to that.";
  }

  if (status === 404) {
    return notFoundMessages[context] ?? contextFallbacks[context];
  }

  if (status === 408) {
    return TIMEOUT_MESSAGE;
  }

  if (status === 409) {
    return "That changed somewhere else in the meantime. Refresh and try again.";
  }

  if (status === 413) {
    return context === "extract"
      ? "That's too large to import. Try a smaller photo or a shorter piece of text."
      : "That's too large to save.";
  }

  if (status === 429) {
    return RATE_LIMIT_MESSAGE;
  }

  if (status >= 500) {
    return SERVER_MESSAGE;
  }

  return null;
};

/**
 * Turns anything thrown by a request into one friendly sentence for the given situation.
 * Feature code should show this instead of `error.message`.
 */
export function getFriendlyErrorMessage(
  error: unknown,
  context: FriendlyErrorContext = "generic"
): string {
  if (isOffline()) {
    return OFFLINE_MESSAGE;
  }

  if (isExtractorApiError(error)) {
    const kind = getApiErrorKind(error);

    // api-client v2 reports transport failures as ExtractorApiError with statusCode 0.
    if (kind === "network") {
      return NETWORK_MESSAGE;
    }

    if (kind === "timeout") {
      return TIMEOUT_MESSAGE;
    }

    if (kind === "validation") {
      return contextFallbacks[context];
    }

    if (kind === "contract") {
      return UNEXPECTED_RESPONSE_MESSAGE;
    }

    const serverMessage = getServerErrorMessage(error);

    // Auth and server failures get our own wording; other 4xx answers can speak for themselves.
    if (
      serverMessage &&
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      error.statusCode !== 401
    ) {
      return serverMessage;
    }

    if (error.statusCode >= 200 && error.statusCode < 300) {
      // A successful status with a body that didn't match the contract.
      return UNEXPECTED_RESPONSE_MESSAGE;
    }

    return messageForStatus(error.statusCode, context) ?? contextFallbacks[context];
  }

  if (isTimeoutError(error)) {
    return TIMEOUT_MESSAGE;
  }

  if (isNetworkError(error)) {
    return NETWORK_MESSAGE;
  }

  if (isZodError(error)) {
    return context === "extract" || context === "save"
      ? "Some details didn't look right. Check them and try again."
      : UNEXPECTED_RESPONSE_MESSAGE;
  }

  return contextFallbacks[context];
}
