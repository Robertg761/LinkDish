import { extractorApiEnv } from "../../../config/env.js";
import { isAbortError } from "../deadline.js";
import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import { HtmlFetchError } from "./errors.js";
import {
  browserLikeHeaders,
  classifyFetchStatusCode,
  createTimeoutSignal,
  detectBlockedSignals,
  isHtmlLikeContentType,
  readLimitedResponseText,
  ResponseBodyTooLargeError,
  sleep
} from "./shared.js";

import type * as DocumentBuilder from "../html/parsed-html-document.js";
import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { FetchResult } from "../types.js";

export { HtmlFetchError } from "./errors.js";

export interface FetchHtmlDocumentOptions {
  timeoutMs: number;
  /** Retries after a connection error. Capped at one; timeouts and HTTP statuses never retry. */
  retries: number;
  blockSignalPatterns?: RegExp[];
  maxBytes?: number;
  maxRedirects?: number;
  validateUrl?: ValidateSourceUrl;
  /** The request deadline or a cancellation; aborts the fetch and suppresses retries. */
  signal?: AbortSignal;
}

const maxConnectionRetries = 1;

/*
 * The HTML parser (cheerio, ~250 ms to import on a cold instance) is only
 * needed once the body has arrived, so its import overlaps the network fetch
 * instead of preceding it.
 */
let documentBuilderModule: Promise<typeof DocumentBuilder> | null = null;

const loadDocumentBuilder = () => {
  documentBuilderModule ??= import("../html/parsed-html-document.js");
  return documentBuilderModule;
};

class ConnectionFailure extends Error {}

export const fetchHtmlDocument = async (
  url: string,
  fetchImplementation: typeof fetch,
  options: FetchHtmlDocumentOptions
): Promise<FetchResult> => {
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? extractorApiEnv.FETCH_MAX_RESPONSE_BYTES;
  const maxRetries = Math.max(0, Math.min(options.retries, maxConnectionRetries));
  const documentBuilder = loadDocumentBuilder();

  void documentBuilder.catch(() => undefined);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const timeout = createTimeoutSignal(options.timeoutMs, options.signal);
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
        try {
          response = await fetchImplementation(requestUrl, {
            headers: browserLikeHeaders,
            redirect: "manual",
            signal: timeout.signal
          });
        } catch (error) {
          throw timeout.signal.aborted || isAbortError(error)
            ? error
            : new ConnectionFailure(
                error instanceof Error ? error.message : "HTML request failed."
              );
        }

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

      const contentType = response.headers.get("content-type");
      const statusFailureKind = classifyFetchStatusCode(response.status);

      if (!isHtmlLikeContentType(contentType)) {
        /* Refuse before buffering: a PDF/zip/video body is never a recipe page. */
        throw new HtmlFetchError(
          `Refused non-HTML response content type: ${contentType ?? "unknown"}`,
          statusFailureKind ?? "unsupported_content_type",
          statusFailureKind ? [] : ["unsupported_content_type"],
          response.status,
          response.url || requestUrl
        );
      }

      const html = await (async () => {
        try {
          return await readLimitedResponseText(response, maxBytes);
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) {
            throw new HtmlFetchError(
              `Failed to fetch HTML document: ${error.message}`,
              "too_large",
              ["response_too_large"],
              response.status,
              response.url || requestUrl
            );
          }

          throw error;
        }
      })();
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
      if (!response.ok && statusFailureKind) {
        throw new HtmlFetchError(
          `Failed to fetch HTML document: ${response.status}`,
          statusFailureKind,
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

      const { buildHtmlSourceDocument } = await documentBuilder;

      return {
        document: buildHtmlSourceDocument({
          url,
          finalUrl: response.url || requestUrl,
          html,
          contentType,
          blockedSignals,
          statusCode: response.status
        }),
        mode: "http",
        blockedSignals
      };
    } catch (error) {
      if (error instanceof HtmlFetchError) {
        throw error;
      }

      if (timeout.signal.aborted || isAbortError(error)) {
        throw new HtmlFetchError(
          options.signal?.aborted && !timeout.timedOut()
            ? "HTML request was cancelled or ran out of request time."
            : "HTML request timed out.",
          "timeout"
        );
      }

      const connectionError = new HtmlFetchError(
        error instanceof Error ? error.message : "HTML request failed.",
        "unreachable"
      );

      if (!(error instanceof ConnectionFailure) || attempt >= maxRetries) {
        throw connectionError;
      }

      await sleep(250);
    } finally {
      timeout.cleanup();
    }
  }

  throw new HtmlFetchError("HTML request failed after retries.", "unreachable");
};
