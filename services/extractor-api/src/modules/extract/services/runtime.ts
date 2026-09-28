import { extractorApiEnv } from "../../../config/env.js";
import { getSharedManagedFallbackExtractor } from "../../admin/model-control.js";
import { createExtractionResultCache } from "../cache/extraction-cache.js";
import { createFallbackHandoffStore } from "../cache/fallback-handoff.js";
import { BrowserFetchError, HtmlFetchError } from "../fetchers/errors.js";
import { getDomainAdapter } from "../source-detection/domain-adapters.js";
import { parseYouTubeVideoId } from "../source-detection/parse-youtube-video-id.js";
import { validatePublicSourceUrl } from "../source-url-safety.js";
import {
  GEMINI_TEXT_CLEANUP_MODEL,
  createGeminiRecipeTextCleaner
} from "../text-cleanup/gemini-recipe-text-cleaner.js";

import type * as BrowserEscalation from "./browser-escalation.js";
import type { RequestDeadline } from "../deadline.js";
import type * as HtmlFetcher from "../fetchers/fetch-html-document.js";
import type * as TikTokFetcher from "../fetchers/fetch-tiktok-document.js";
import type * as YouTubeFetcher from "../fetchers/fetch-youtube-document.js";
import type {
  BrowserFetcher,
  ExtractorRuntime,
  FetchResult,
  RecipeTextCleaner,
  SourceFetchOptions,
  YouTubeSourceDocument
} from "../types.js";

const fetchImplementation = fetch;
let sharedRuntime: ExtractorRuntime | null = null;

/*
 * The fetchers (and through them the HTML parser and Playwright) load on the
 * first fetch instead of when the /extract function boots, so requests that
 * never fetch (cache hits, billing denials, unsupported links) skip them.
 */
let htmlFetcherModule: Promise<typeof HtmlFetcher> | null = null;
let browserEscalationModule: Promise<typeof BrowserEscalation> | null = null;
let youTubeFetcherModule: Promise<typeof YouTubeFetcher> | null = null;
let tikTokFetcherModule: Promise<typeof TikTokFetcher> | null = null;

const loadHtmlFetcher = () => {
  htmlFetcherModule ??= import("../fetchers/fetch-html-document.js");
  return htmlFetcherModule;
};

const loadBrowserEscalation = () => {
  browserEscalationModule ??= import("./browser-escalation.js");
  return browserEscalationModule;
};

const loadTikTokFetcher = () => {
  tikTokFetcherModule ??= import("../fetchers/fetch-tiktok-document.js");
  return tikTokFetcherModule;
};

const loadYouTubeFetcher = () => {
  youTubeFetcherModule ??= import("../fetchers/fetch-youtube-document.js");
  return youTubeFetcherModule;
};

/* Time kept back after a browser render for parsing, extraction and the response. */
const browserRenderReserveMs = 3_000;
/* Below this much remaining time a browser render cannot finish, so it is not started. */
const minimumBrowserBudgetMs = 4_000;

const getBlockSignalPatterns = (url: string): RegExp[] | undefined => {
  try {
    return getDomainAdapter(new URL(url).hostname.toLowerCase())?.blockSignals;
  } catch {
    return undefined;
  }
};

const createRecipeTextCleaner = (): RecipeTextCleaner =>
  createGeminiRecipeTextCleaner({
    apiKey: extractorApiEnv.RECIPE_TEXT_CLEANUP_ENABLED
      ? extractorApiEnv.GEMINI_API_KEY
      : undefined,
    model: GEMINI_TEXT_CLEANUP_MODEL,
    fetchImplementation,
    timeoutMs: Math.min(extractorApiEnv.LLM_FALLBACK_TIMEOUT_MS, 8_000)
  });

export const createDefaultExtractorRuntime = (): ExtractorRuntime => {
  const browserEnabled = extractorApiEnv.BROWSER_FETCH_ENABLED;
  let browserFetcherPromise: Promise<BrowserFetcher> | null = null;

  const getBrowserFetcher = () => {
    browserFetcherPromise ??= import("../fetchers/fetch-browser-document.js").then(
      ({ createBrowserFetcher }) =>
        createBrowserFetcher({
          enabled: browserEnabled,
          timeoutMs: extractorApiEnv.BROWSER_FETCH_TIMEOUT_MS,
          concurrency: extractorApiEnv.BROWSER_FETCH_CONCURRENCY
        })
    );

    return browserFetcherPromise;
  };

  const fetchWithBrowser = async (
    url: string,
    deadline: RequestDeadline | undefined,
    blockSignalPatterns: RegExp[] | undefined
  ): Promise<FetchResult> => {
    const timeoutMs = deadline
      ? deadline.budgetMs(extractorApiEnv.BROWSER_FETCH_TIMEOUT_MS, browserRenderReserveMs)
      : extractorApiEnv.BROWSER_FETCH_TIMEOUT_MS;

    if (timeoutMs < minimumBrowserBudgetMs) {
      throw new BrowserFetchError("Not enough request time left for a browser render.", "timeout");
    }

    const browserFetcher = await getBrowserFetcher();

    return browserFetcher.fetch(url, {
      timeoutMs,
      ...(deadline
        ? {
            signal: deadline.signal,
            queueTimeoutMs: deadline.budgetMs(Number.POSITIVE_INFINITY, timeoutMs)
          }
        : {}),
      ...(blockSignalPatterns ? { blockSignalPatterns } : {})
    });
  };

  return {
    fetchImplementation,
    fetchHtmlDocument: async (url: string, options?: SourceFetchOptions): Promise<FetchResult> => {
      const deadline = options?.deadline;
      const blockSignalPatterns = getBlockSignalPatterns(url);

      try {
        const { fetchHtmlDocument } = await loadHtmlFetcher();
        const httpResult = await fetchHtmlDocument(url, fetchImplementation, {
          timeoutMs: deadline
            ? deadline.budgetMs(extractorApiEnv.FETCH_HTTP_TIMEOUT_MS)
            : extractorApiEnv.FETCH_HTTP_TIMEOUT_MS,
          /* The browser is the retry when it is available, so HTTP does not retry first. */
          retries: browserEnabled ? 0 : extractorApiEnv.FETCH_HTTP_RETRIES,
          ...(blockSignalPatterns ? { blockSignalPatterns } : {}),
          ...(deadline ? { signal: deadline.signal } : {})
        });
        const { shouldUseBrowserFallback } = await loadBrowserEscalation();

        if (
          shouldUseBrowserFallback({
            available: browserEnabled,
            blockedSignals: httpResult.blockedSignals,
            html: httpResult.document.html,
            document: httpResult.document
          })
        ) {
          return await fetchWithBrowser(url, deadline, blockSignalPatterns);
        }

        return httpResult;
      } catch (error) {
        if (
          browserEnabled &&
          !deadline?.signal.aborted &&
          error instanceof HtmlFetchError &&
          (error.reason === "blocked" ||
            error.reason === "timeout" ||
            error.reason === "unreachable")
        ) {
          return fetchWithBrowser(url, deadline, blockSignalPatterns);
        }

        if (error instanceof BrowserFetchError || error instanceof HtmlFetchError) {
          throw error;
        }

        throw new HtmlFetchError(
          error instanceof Error ? error.message : "HTML fetch failed.",
          "unreachable"
        );
      }
    },
    fetchYouTubeDocument: async (
      url: string,
      videoId: string,
      options?: SourceFetchOptions
    ): Promise<YouTubeSourceDocument> => {
      const deadline = options?.deadline;
      const { fetchYouTubeDocument } = await loadYouTubeFetcher();

      return fetchYouTubeDocument(
        url,
        videoId,
        fetchImplementation,
        deadline
          ? deadline.budgetMs(extractorApiEnv.FETCH_HTTP_TIMEOUT_MS)
          : extractorApiEnv.FETCH_HTTP_TIMEOUT_MS,
        deadline ? { signal: deadline.signal } : undefined
      );
    },
    fetchSocialDocument: async (url: string, options?: SourceFetchOptions) => {
      const deadline = options?.deadline;
      const { fetchTikTokDocument } = await loadTikTokFetcher();

      return fetchTikTokDocument(url, fetchImplementation, {
        timeoutMs: deadline
          ? deadline.budgetMs(extractorApiEnv.FETCH_HTTP_TIMEOUT_MS)
          : extractorApiEnv.FETCH_HTTP_TIMEOUT_MS,
        ...(deadline ? { signal: deadline.signal } : {}),
        validateUrl: validatePublicSourceUrl
      });
    },
    fallbackExtractor: getSharedManagedFallbackExtractor(fetchImplementation),
    recipeTextCleaner: createRecipeTextCleaner(),
    ...(extractorApiEnv.EXTRACT_CACHE_ENABLED
      ? {
          extractionCache: createExtractionResultCache({
            ttlSeconds: extractorApiEnv.EXTRACT_CACHE_TTL_SECONDS
          })
        }
      : {}),
    fallbackHandoffStore: createFallbackHandoffStore(),
    validateSourceUrl: validatePublicSourceUrl,
    dispose: async () => {
      const browserFetcher = await browserFetcherPromise?.catch(() => null);
      await browserFetcher?.dispose();
    }
  };
};

export const getSharedExtractorRuntime = (): ExtractorRuntime => {
  if (!sharedRuntime) {
    sharedRuntime = createDefaultExtractorRuntime();
  }

  return sharedRuntime;
};

export const assertYouTubeVideoId = (url: string): string | null => parseYouTubeVideoId(url);
