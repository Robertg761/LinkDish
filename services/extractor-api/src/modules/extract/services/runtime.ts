import { extractorApiEnv } from "../../../config/env.js";
import { getSharedManagedFallbackExtractor } from "../../admin/model-control.js";
import {
  BrowserFetchError,
  HtmlFetchError,
  createBrowserFetcher,
  fetchHtmlDocument,
  fetchYouTubeDocument
} from "../fetchers/index.js";
import { looksLikeShellHtml, looksLikeThinHtml } from "../fetchers/shared.js";
import { parseYouTubeVideoId } from "../source-detection/parse-youtube-video-id.js";
import { validatePublicSourceUrl } from "../source-url-safety.js";
import {
  GEMINI_TEXT_CLEANUP_MODEL,
  createGeminiRecipeTextCleaner
} from "../text-cleanup/gemini-recipe-text-cleaner.js";

import type { ExtractorRuntime, FetchResult, YouTubeSourceDocument } from "../types.js";

const fetchImplementation = fetch;
let sharedRuntime: ExtractorRuntime | null = null;

export const createDefaultExtractorRuntime = (): ExtractorRuntime => {
  const browserFetcher = createBrowserFetcher({
    enabled: extractorApiEnv.BROWSER_FETCH_ENABLED,
    timeoutMs: extractorApiEnv.BROWSER_FETCH_TIMEOUT_MS,
    concurrency: extractorApiEnv.BROWSER_FETCH_CONCURRENCY
  });

  return {
    fetchImplementation,
    fetchHtmlDocument: async (url: string): Promise<FetchResult> => {
      try {
        const httpResult = await fetchHtmlDocument(url, fetchImplementation, {
          timeoutMs: extractorApiEnv.FETCH_HTTP_TIMEOUT_MS,
          retries: extractorApiEnv.FETCH_HTTP_RETRIES
        });

        if (
          browserFetcher.available &&
          (httpResult.blockedSignals.length > 0 ||
            looksLikeShellHtml(httpResult.document.html) ||
            looksLikeThinHtml(httpResult.document.html))
        ) {
          return browserFetcher.fetch(url);
        }

        return httpResult;
      } catch (error) {
        if (
          browserFetcher.available &&
          error instanceof HtmlFetchError &&
          (error.reason === "blocked" ||
            error.reason === "timeout" ||
            error.reason === "unreachable")
        ) {
          return browserFetcher.fetch(url);
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
    fetchYouTubeDocument: async (url: string, videoId: string): Promise<YouTubeSourceDocument> =>
      fetchYouTubeDocument(
        url,
        videoId,
        fetchImplementation,
        extractorApiEnv.FETCH_HTTP_TIMEOUT_MS
      ),
    fallbackExtractor: getSharedManagedFallbackExtractor(fetchImplementation),
    recipeTextCleaner: createGeminiRecipeTextCleaner({
      apiKey: extractorApiEnv.GEMINI_API_KEY,
      model: GEMINI_TEXT_CLEANUP_MODEL,
      fetchImplementation,
      timeoutMs: Math.min(extractorApiEnv.LLM_FALLBACK_TIMEOUT_MS, 8_000)
    }),
    validateSourceUrl: validatePublicSourceUrl,
    dispose: () => browserFetcher.dispose()
  };
};

export const getSharedExtractorRuntime = (): ExtractorRuntime => {
  if (!sharedRuntime) {
    sharedRuntime = createDefaultExtractorRuntime();
  }

  return sharedRuntime;
};

export const assertYouTubeVideoId = (url: string): string | null => parseYouTubeVideoId(url);
