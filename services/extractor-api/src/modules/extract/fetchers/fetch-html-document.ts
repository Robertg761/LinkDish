import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import {
  browserLikeHeaders,
  buildHtmlSourceDocument,
  classifyFetchStatusCode,
  createTimeoutSignal,
  detectBlockedSignals,
  sleep
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { FetchResult, InternalFetchFailureKind } from "../types.js";

export class HtmlFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: InternalFetchFailureKind,
    public readonly blockedSignals: string[] = [],
    public readonly statusCode?: number,
    public readonly finalUrl?: string
  ) {
    super(message);
    this.name = "HtmlFetchError";
  }
}

export interface FetchHtmlDocumentOptions {
  timeoutMs: number;
  retries: number;
  blockSignalPatterns?: RegExp[];
  maxRedirects?: number;
  validateUrl?: ValidateSourceUrl;
}

const shouldRetry = (error: HtmlFetchError, attempt: number, maxRetries: number): boolean => {
  if (attempt >= maxRetries) {
    return false;
  }

  return error.reason === "timeout" || error.reason === "unreachable";
};

export const fetchHtmlDocument = async (
  url: string,
  fetchImplementation: typeof fetch,
  options: FetchHtmlDocumentOptions
): Promise<FetchResult> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const maxRedirects = options.maxRedirects ?? 5;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const timeout = createTimeoutSignal(options.timeoutMs);
    let requestUrl = url;

    try {
      const initialSafety = await validateUrl(requestUrl);

      if (isSourceUrlRejection(initialSafety)) {
        throw new HtmlFetchError(
          `Refused unsafe source URL: ${initialSafety.reason}`,
          initialSafety.reason === "dns_lookup_failed" ? "unreachable" : "blocked"
        );
      }

      let response: Response | null = null;

      for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        response = await fetchImplementation(requestUrl, {
          headers: browserLikeHeaders,
          redirect: "manual",
          signal: timeout.signal
        });

        if (response.status < 300 || response.status >= 400) {
          break;
        }

        const location = response.headers.get("location");

        if (!location) {
          break;
        }

        if (redirectCount === maxRedirects) {
          throw new HtmlFetchError(
            `Failed to fetch HTML document: too many redirects`,
            "blocked",
            ["too_many_redirects"],
            response.status,
            requestUrl
          );
        }

        const redirectUrl = new URL(location, requestUrl).toString();
        const redirectSafety = await validateUrl(redirectUrl);

        if (isSourceUrlRejection(redirectSafety)) {
          throw new HtmlFetchError(
            `Refused unsafe redirect target: ${redirectSafety.reason}`,
            redirectSafety.reason === "dns_lookup_failed" ? "unreachable" : "blocked",
            [`unsafe_redirect:${redirectSafety.reason}`],
            response.status,
            redirectUrl
          );
        }

        requestUrl = redirectUrl;
      }

      if (!response) {
        throw new HtmlFetchError("HTML request failed.", "unreachable");
      }

      const html = await response.text();
      const blockedSignals = detectBlockedSignals(
        options.blockSignalPatterns
          ? {
              html,
              statusCode: response.status,
              extraPatterns: options.blockSignalPatterns
            }
          : {
              html,
              statusCode: response.status
            }
      );
      const failureKind = classifyFetchStatusCode(response.status);

      if (!response.ok && failureKind) {
        throw new HtmlFetchError(
          `Failed to fetch HTML document: ${response.status}`,
          failureKind,
          blockedSignals,
          response.status,
          response.url || requestUrl
        );
      }

      if (!response.ok) {
        throw new HtmlFetchError(
          `Failed to fetch HTML document: ${response.status}`,
          "unreachable",
          blockedSignals,
          response.status,
          response.url || requestUrl
        );
      }

      return {
        document: buildHtmlSourceDocument({
          url,
          finalUrl: response.url || requestUrl,
          html,
          contentType: response.headers.get("content-type"),
          blockedSignals,
          statusCode: response.status
        }),
        mode: "http",
        blockedSignals
      };
    } catch (error) {
      const normalizedError =
        error instanceof HtmlFetchError
          ? error
          : new HtmlFetchError(
              error instanceof Error && error.name === "AbortError"
                ? "HTML request timed out."
                : error instanceof Error
                  ? error.message
                  : "HTML request failed.",
              error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable"
            );

      if (!shouldRetry(normalizedError, attempt, options.retries)) {
        throw normalizedError;
      }

      await sleep(250 * (attempt + 1));
    } finally {
      timeout.cleanup();
    }
  }

  throw new HtmlFetchError("HTML request failed after retries.", "unreachable");
};
