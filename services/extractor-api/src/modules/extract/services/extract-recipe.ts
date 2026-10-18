import { createHash } from "node:crypto";

import {
  extractRecipeResponseSchema,
  type ExtractRecipeAnyRequest,
  type ExtractRecipeImage,
  type ExtractRecipeResponse,
  type ExtractRecipeSuccess
} from "../../../../../../packages/api-contracts/src/index.js";
import {
  computeMissingRecipeFields,
  hasRequiredRecipeFields,
  type Recipe,
  type SourceType
} from "../../../../../../packages/recipe-domain/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { isStrongStructuredCandidate } from "../confidence/score-recipe.js";
import { successConfidenceThresholds } from "../confidence/thresholds.js";
import {
  createRequestDeadline,
  ExtractionCancelledError,
  type RequestDeadline
} from "../deadline.js";
import { looksLikeRecipeText } from "../extractors/recipe-text-signals.js";
import { FallbackProviderError } from "../fallback/errors.js";
import {
  BrowserFetchError,
  HtmlFetchError,
  SocialFetchError,
  YouTubeFetchError
} from "../fetchers/errors.js";
import { looksLikeNotFoundTitle, looksLikeUnrelatedRedirect } from "../fetchers/shared.js";
import { normalizeExtractionCandidate } from "../normalizers/index.js";
import {
  detectHostedMediaSourceType,
  detectSourceTypeFromUrl,
  isPinterestPinUrl,
  TIKTOK_ADAPTER_KEY
} from "../source-detection/detect-source-from-url.js";
import { toYouTubeWatchUrl } from "../source-detection/parse-youtube-video-id.js";
import { isSourceUrlRejection } from "../source-url-safety.js";
import { recipeNeedsTextCleanup } from "../text-cleanup/needs-text-cleanup.js";

import { assertYouTubeVideoId, getSharedExtractorRuntime } from "./runtime.js";

import type * as HtmlAnalysis from "./html-analysis.js";
import type { FetchMode } from "../../../../../../packages/api-contracts/src/index.js";
import type { CachedExtraction } from "../cache/extraction-cache.js";
import type {
  DetectionResult,
  DeterministicDecision,
  DeterministicFailureDecision,
  ExtractionCandidate,
  ExtractionLogContext,
  ExtractorRuntime,
  HtmlSourceDocument,
  NormalizedExtraction,
  SourceDocument,
  TextSourceDocument,
  YouTubeSourceDocument
} from "../types.js";

type ExtractRecipeUrlRequest = {
  attempt: "primary" | "fallback";
  url: string;
};

type ExtractRecipeImageRequest = {
  attempt: "fallback";
  images: ExtractRecipeImage[];
  sourceUrl: string;
};

type TextImportRequest = {
  text: string;
  sourceUrl?: string | undefined;
};

type ExtractionResult = {
  response: ExtractRecipeResponse;
  logContext: Omit<ExtractionLogContext, "latencyMs">;
};

export interface ExtractRecipeOptions {
  /** Cancels outbound work, e.g. when billing denies a request whose fetch already started. */
  signal?: AbortSignal;
  /** The request deadline; defaults to EXTRACT_REQUEST_DEADLINE_MS from the start of extraction. */
  deadline?: RequestDeadline;
  /**
   * Resolves once billing has decided. The page fetch may start before it
   * does, but deterministic extraction, browser-free CPU work after the fetch,
   * LLM calls and cache writes wait for `true`; `false` cancels the extraction.
   */
  authorization?: Promise<boolean>;
  /** The client's import correlation id. */
  correlationId?: string;
  /**
   * "default" reads and writes the result cache, "refresh" skips reads but
   * stores fresh results (the live canary), "bypass" does neither.
   */
  cacheMode?: "default" | "refresh" | "bypass";
  /** Keeps work alive past the response (cache writes); Vercel passes waitUntil. */
  schedule?: (task: Promise<unknown>) => void;
}

interface ExtractionContext {
  runtime: ExtractorRuntime;
  deadline: RequestDeadline;
  authorization: Promise<boolean>;
  cacheMode: NonNullable<ExtractRecipeOptions["cacheMode"]>;
  /** Starts `task` and lets it finish after the response. Never rejects. */
  afterResponse(task: () => Promise<void>, failureEvent?: string): Promise<void>;
}

const logTaskFailure = (event: string) => (error: unknown) => {
  console.warn(
    JSON.stringify({
      event,
      message: error instanceof Error ? error.message : "Unknown error"
    })
  );
};

const unsupportedSourceMessages = {
  social:
    "Instagram and Facebook links are not supported yet. Paste a written recipe page instead.",
  video: "That video site is not supported yet. Paste a written recipe page instead.",
  unknown: "That source is not supported yet."
} as const;

/* Text cleanup is skipped when less than this is left, and gets at most `textCleanupMaxMs`. */
const minimumTextCleanupBudgetMs = 2_000;
const textCleanupMaxMs = 8_000;
const textCleanupReserveMs = 1_000;

/* Social, video and unknown sources are never cached (they skip the lookup). */
const isUnsupportedInitialSource = (
  sourceType: DetectionResult["sourceType"]
): sourceType is keyof typeof unsupportedSourceMessages =>
  sourceType === "social" || sourceType === "video" || sourceType === "unknown";

/* TikTok is the one social platform with a supported path: its caption, via oEmbed. */
const isSupportedSocialSource = (detection: DetectionResult, runtime: ExtractorRuntime) =>
  detection.sourceType === "social" &&
  detection.adapterKey === TIKTOK_ADAPTER_KEY &&
  typeof runtime.fetchSocialDocument === "function";

const createExtractionContext = (
  runtime: ExtractorRuntime,
  options: ExtractRecipeOptions
): { context: ExtractionContext; dispose: () => void } => {
  const deadline =
    options.deadline ??
    createRequestDeadline(extractorApiEnv.EXTRACT_REQUEST_DEADLINE_MS, options.signal);
  const schedule = options.schedule;
  /* Hands a started task to the scheduler; post-response bookkeeping must never fail an import. */
  const keepAlive = (task: Promise<void>): boolean => {
    if (!schedule) {
      return false;
    }

    try {
      schedule(task);
    } catch (error) {
      logTaskFailure("extract_schedule_failed")(error);
    }

    return true;
  };

  return {
    context: {
      runtime,
      deadline,
      authorization: options.authorization ?? Promise.resolve(true),
      cacheMode: options.cacheMode ?? "default",
      afterResponse: async (task, failureEvent = "extract_post_response_task_failed") => {
        const guardedTask = task().catch(logTaskFailure(failureEvent));

        if (!keepAlive(guardedTask)) {
          await guardedTask;
        }
      }
    },
    dispose: () => {
      if (!options.deadline) {
        deadline.dispose();
      }
    }
  };
};

/* Paid or CPU-heavy steps only run once billing has allowed the request. */
const ensureAuthorized = async (context: ExtractionContext): Promise<void> => {
  if (!(await context.authorization)) {
    throw new ExtractionCancelledError("Billing did not authorize this extraction.");
  }
};

const refreshFallbackSettings = async (runtime: ExtractorRuntime): Promise<void> => {
  await runtime.fallbackExtractor.refresh?.().catch(() => undefined);
};

const buildFailureDecision = (
  reason: DeterministicFailureDecision["reason"],
  userMessage: string,
  recovery: DeterministicFailureDecision["recovery"]
): DeterministicFailureDecision => ({
  kind: "failure",
  reason,
  userMessage,
  recovery
});

const makeLogContext = ({
  hostname,
  detection,
  attempt,
  response,
  strategy,
  fetchMode,
  fallbackProvider,
  statusCode,
  finalUrl,
  blockedSignals,
  browserAttempted,
  textCleanup
}: {
  hostname: string;
  detection: DetectionResult;
  attempt: "primary" | "fallback";
  response: ExtractRecipeResponse;
  strategy: ExtractionLogContext["strategy"];
  fetchMode: ExtractionLogContext["fetchMode"];
  fallbackProvider: ExtractionLogContext["fallbackProvider"];
  statusCode?: number | null;
  finalUrl?: string | null;
  blockedSignals?: string[];
  browserAttempted?: boolean;
  textCleanup?: ExtractionLogContext["textCleanup"];
}): Omit<ExtractionLogContext, "latencyMs"> => ({
  hostname,
  sourceType: detection.sourceType,
  detectionConfidence: detection.confidence,
  attempt,
  outcomeStatus: response.status,
  strategy,
  fetchMode,
  confidenceScore:
    response.status === "success"
      ? response.extraction.confidenceScore
      : response.status === "needs_retry"
        ? response.diagnostics.confidenceScore
        : null,
  missingFieldCount:
    response.status === "success"
      ? response.extraction.missingFields.length
      : response.status === "needs_retry"
        ? response.diagnostics.missingFields.length
        : 0,
  fallbackProvider,
  failureReason: response.status === "failure" ? response.reason : null,
  statusCode: statusCode ?? null,
  finalUrl: finalUrl ?? null,
  blockedSignals: blockedSignals ?? [],
  browserAttempted: browserAttempted ?? fetchMode === "browser",
  ...(textCleanup ? { textCleanup } : {})
});

const getDocumentLogFields = (sourceDocument: SourceDocument, fetchMode: FetchMode) => ({
  statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
  finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
  blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
  browserAttempted: fetchMode === "browser"
});

const mapFetchErrorToResponse = (
  error: unknown,
  sourceType: DetectionResult["sourceType"]
): ExtractRecipeResponse => {
  if (
    error instanceof BrowserFetchError ||
    error instanceof HtmlFetchError ||
    error instanceof YouTubeFetchError ||
    error instanceof SocialFetchError
  ) {
    if (error.reason === "timeout") {
      return extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "timeout",
        userMessage: "That source took too long to respond.",
        recovery: {
          retryable: true,
          allowFallback: false,
          suggestedAction: "retry_primary"
        }
      });
    }

    if (error.reason === "blocked") {
      return extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "source_blocked",
        userMessage:
          sourceType === "youtube"
            ? "That YouTube source blocked extraction right now."
            : sourceType === "social"
              ? "TikTok did not let LinkDish read that video right now."
              : "That site blocked recipe extraction right now.",
        recovery: {
          retryable: false,
          allowFallback: false,
          suggestedAction: "try_another_url"
        }
      });
    }

    if (error.reason === "too_large") {
      return extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "source_unreachable",
        userMessage: "That page is too large for LinkDish to read.",
        recovery: {
          retryable: false,
          allowFallback: false,
          suggestedAction: "try_another_url"
        }
      });
    }

    if (error.reason === "unsupported_content_type") {
      return extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "unsupported_source",
        userMessage: "That link does not point to a web page LinkDish can read.",
        recovery: {
          retryable: false,
          allowFallback: false,
          suggestedAction: "try_another_url"
        }
      });
    }

    if (error.reason === "not_found") {
      return extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "parse_failed",
        userMessage:
          sourceType === "social"
            ? "That video is private, removed or not available to read."
            : "That page no longer exists or has moved.",
        recovery: {
          retryable: false,
          allowFallback: false,
          suggestedAction: "try_another_url"
        }
      });
    }
  }

  return extractRecipeResponseSchema.parse({
    status: "failure",
    reason: "source_unreachable",
    userMessage: "We could not reach that source right now.",
    recovery: {
      retryable: true,
      allowFallback: false,
      suggestedAction: "retry_primary"
    }
  });
};

const getFetchErrorMetadata = (error: unknown) => {
  if (
    error instanceof BrowserFetchError ||
    error instanceof HtmlFetchError ||
    error instanceof YouTubeFetchError ||
    error instanceof SocialFetchError
  ) {
    return {
      statusCode:
        "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null,
      finalUrl: "finalUrl" in error && typeof error.finalUrl === "string" ? error.finalUrl : null,
      blockedSignals:
        "blockedSignals" in error && Array.isArray(error.blockedSignals)
          ? error.blockedSignals
          : [],
      browserAttempted: error instanceof BrowserFetchError
    };
  }

  return {
    statusCode: null,
    finalUrl: null,
    blockedSignals: [],
    browserAttempted: false
  };
};

/*
 * Parser-backed steps are loaded once an HTML page has been fetched, so the
 * /extract function boots without the HTML parser (cache hits, billing
 * denials and rejected links never need it).
 */
let htmlAnalysisModule: Promise<typeof HtmlAnalysis> | null = null;

const loadHtmlAnalysis = () => {
  htmlAnalysisModule ??= import("./html-analysis.js");
  return htmlAnalysisModule;
};

const detectFetchedDocumentFailure = async (
  requestUrl: string,
  sourceDocument: SourceDocument
): Promise<ExtractRecipeResponse | null> => {
  if (sourceDocument.kind !== "html") {
    return null;
  }

  const { looksLikeNotFoundHtml } = await loadHtmlAnalysis();

  if (
    sourceDocument.statusCode === 404 ||
    sourceDocument.statusCode === 410 ||
    looksLikeNotFoundTitle(sourceDocument.title) ||
    looksLikeNotFoundHtml(sourceDocument)
  ) {
    return extractRecipeResponseSchema.parse({
      status: "failure",
      reason: "parse_failed",
      userMessage: "That page no longer exists or has moved.",
      recovery: {
        retryable: false,
        allowFallback: false,
        suggestedAction: "try_another_url"
      }
    });
  }

  if (
    looksLikeUnrelatedRedirect({
      requestedUrl: requestUrl,
      finalUrl: sourceDocument.finalUrl,
      title: sourceDocument.title,
      html: sourceDocument.html
    })
  ) {
    return extractRecipeResponseSchema.parse({
      status: "failure",
      reason: "parse_failed",
      userMessage: "That URL redirected to unrelated content, so we could not extract a recipe.",
      recovery: {
        retryable: false,
        allowFallback: false,
        suggestedAction: "try_another_url"
      }
    });
  }

  return null;
};

interface FetchedSource {
  sourceDocument: SourceDocument;
  fetchMode: FetchMode;
  detection: DetectionResult;
  /**
   * The URL whose content was fetched and becomes the recipe's sourceUrl: the requested URL,
   * or the recipe page a Pinterest pin links to.
   */
  sourceUrl: string;
}

const fetchSourceDocument = async (
  url: string,
  detection: DetectionResult,
  context: ExtractionContext
): Promise<FetchedSource> => {
  const { runtime, deadline } = context;

  if (detection.sourceType === "youtube") {
    const videoId = assertYouTubeVideoId(url);

    if (!videoId) {
      throw new YouTubeFetchError("Missing YouTube video id.", "unreachable");
    }

    return {
      sourceDocument: await runtime.fetchYouTubeDocument(url, videoId, { deadline }),
      fetchMode: "http",
      detection,
      sourceUrl: url
    };
  }

  /* The HTTP fetch may overlap billing; a browser render waits for it to allow the request. */
  const fetchResult = await runtime.fetchHtmlDocument(url, {
    deadline,
    awaitAuthorized: () => ensureAuthorized(context)
  });
  const { detectSourceType } = await loadHtmlAnalysis();

  return {
    sourceDocument: fetchResult.document,
    fetchMode: fetchResult.mode,
    detection: detectSourceType(url, fetchResult.document),
    sourceUrl: url
  };
};

/**
 * A Pinterest pin (or a pin.it link that landed on one) is only a pointer: the recipe is on
 * the site the pin links to. That outbound link is validated like any user URL before it is
 * fetched. Pins without a usable link are extracted as they are.
 */
const readPinterestOutboundUrl = async (
  fetched: FetchedSource,
  context: ExtractionContext
): Promise<string | null> => {
  const { sourceDocument } = fetched;

  if (sourceDocument.kind !== "html" || !isPinterestPinUrl(sourceDocument.finalUrl)) {
    return null;
  }

  const { findPinterestOutboundUrl } = await loadHtmlAnalysis();
  const outboundUrl = findPinterestOutboundUrl(sourceDocument);

  if (!outboundUrl) {
    return null;
  }

  const safety = await context.runtime.validateSourceUrl(outboundUrl);

  return isSourceUrlRejection(safety) ? null : outboundUrl;
};

const withRuntimeSignals = (
  candidate: ExtractionCandidate | null,
  detection: DetectionResult,
  fetchMode: FetchMode,
  sourceDocument: SourceDocument
): ExtractionCandidate | null => {
  if (!candidate) {
    return null;
  }

  return {
    ...candidate,
    signals: {
      ...candidate.signals,
      detectionConfidence: detection.confidence,
      usedBrowserFallback: fetchMode === "browser",
      blockedSourceSignals:
        sourceDocument.kind === "html" ? sourceDocument.blockedSignals.length : 0
    }
  };
};

const loadRecipeWebpageExtractor = async () => {
  const module = await import("../extractors/recipe-webpage/extract-recipe-webpage.js");
  return module.extractRecipeWebpage;
};

/* JSDOM + Readability (~400 ms to import) only load when the article path actually runs. */
const loadArticleExtractor = async () => {
  const module = await import("../extractors/article/extract-article-recipe.js");
  return module.extractArticleRecipe;
};

const loadYouTubeExtractorModule = () => import("../extractors/youtube/extract-youtube-recipe.js");

const loadYouTubeExtractor = async () => (await loadYouTubeExtractorModule()).extractYouTubeRecipe;

const runHtmlExtractors = async (
  sourceDocument: HtmlSourceDocument,
  order: "webpage-first" | "article-first"
): Promise<ExtractionCandidate | null> => {
  if (order === "webpage-first") {
    const webpageCandidate = (await loadRecipeWebpageExtractor())(sourceDocument);
    return webpageCandidate ?? (await loadArticleExtractor())(sourceDocument);
  }

  const articleCandidate = (await loadArticleExtractor())(sourceDocument);
  return articleCandidate ?? (await loadRecipeWebpageExtractor())(sourceDocument);
};

const runDeterministicExtraction = async (
  sourceDocument: SourceDocument,
  detection: DetectionResult,
  fetchMode: FetchMode
): Promise<ExtractionCandidate | null> => {
  if (sourceDocument.kind === "html" && detection.sourceType === "recipe-webpage") {
    return withRuntimeSignals(
      await runHtmlExtractors(sourceDocument, "webpage-first"),
      detection,
      fetchMode,
      sourceDocument
    );
  }

  if (sourceDocument.kind === "html" && detection.sourceType === "article") {
    return withRuntimeSignals(
      await runHtmlExtractors(sourceDocument, "article-first"),
      detection,
      fetchMode,
      sourceDocument
    );
  }

  if (sourceDocument.kind === "youtube" && detection.sourceType === "youtube") {
    const extractYouTubeRecipe = await loadYouTubeExtractor();

    return withRuntimeSignals(
      extractYouTubeRecipe(sourceDocument)?.candidate ?? null,
      detection,
      fetchMode,
      sourceDocument
    );
  }

  return null;
};

const noRecipeRecovery = {
  retryable: false,
  allowFallback: false,
  suggestedAction: "try_another_url"
} as const;

const describeMissingRequiredFields = (recipe: Partial<Recipe>): string => {
  const missing = [
    ...(typeof recipe.title === "string" && recipe.title.trim().length > 0 ? [] : ["a title"]),
    ...((recipe.ingredients?.length ?? 0) > 0 ? [] : ["the ingredients"]),
    ...((recipe.steps?.length ?? 0) > 0 ? [] : ["the method"])
  ];

  return missing.length === 0
    ? "LinkDish couldn't read a complete recipe from that page."
    : `LinkDish couldn't find ${missing.join(" or ")} on that page.`;
};

/*
 * Every link is answered by the deterministic extractors alone: a recipe the page (or video
 * description) states clearly is a success, anything less is a plain failure. Nothing is
 * guessed at, so a weak read is never saved as a recipe.
 */
const decidePrimaryOutcome = (
  request: ExtractRecipeUrlRequest,
  detection: DetectionResult,
  fetchMode: FetchMode,
  candidate: ExtractionCandidate | null
): DeterministicDecision => {
  const sourceType = detection.sourceType;

  if (sourceType !== "recipe-webpage" && sourceType !== "article" && sourceType !== "youtube") {
    return buildFailureDecision("unsupported_source", "That source is not supported yet.", {
      retryable: false,
      allowFallback: false,
      suggestedAction: "try_another_url"
    });
  }

  if (!candidate) {
    return buildFailureDecision(
      "parse_failed",
      sourceType === "youtube"
        ? "That video's description doesn't include a written recipe. Try the recipe's website instead."
        : "LinkDish couldn't find a recipe on that page.",
      noRecipeRecovery
    );
  }

  if (!hasRequiredRecipeFields(candidate.recipe)) {
    return buildFailureDecision(
      "parse_failed",
      describeMissingRequiredFields(candidate.recipe),
      noRecipeRecovery
    );
  }

  const normalized = normalizeExtractionCandidate(candidate, sourceType, request.url, fetchMode);

  if (!normalized) {
    return buildFailureDecision(
      "parse_failed",
      describeMissingRequiredFields(candidate.recipe),
      noRecipeRecovery
    );
  }

  /*
   * A site's own Recipe JSON-LD/microdata with a title, ingredients and steps is a success even
   * when servings or times are missing (the normaliser notes the gaps as a warning). A YouTube
   * candidate only exists when the description lays out an ingredient list (see
   * buildTextRecipeCandidate), so it needs no confidence bar of its own.
   */
  if (
    sourceType !== "youtube" &&
    normalized.confidenceScore < successConfidenceThresholds[sourceType] &&
    !isStrongStructuredCandidate(candidate)
  ) {
    return buildFailureDecision(
      "parse_failed",
      "LinkDish found parts of a recipe on that page, but not enough to save it reliably.",
      noRecipeRecovery
    );
  }

  return {
    kind: "success",
    result: {
      ...normalized,
      missingFields: computeMissingRecipeFields(candidate.recipe)
    }
  };
};

const asApiResponse = (decision: DeterministicDecision): ExtractRecipeResponse => {
  if (decision.kind === "success") {
    return {
      status: "success",
      recipe: decision.result.recipe,
      extraction: {
        sourceType: decision.result.sourceType,
        strategy: decision.result.strategy,
        confidenceScore: decision.result.confidenceScore,
        missingFields: decision.result.missingFields,
        warnings: decision.result.warnings,
        fetchMode: decision.result.fetchMode,
        provenance: decision.result.provenance
      }
    };
  }

  return {
    status: "failure",
    reason: decision.reason,
    userMessage: decision.userMessage,
    recovery: decision.recovery
  };
};

/*
 * Photo scans are the one import read by an LLM. The Gemini cleanup pass is a second LLM call on
 * that result, so it only runs when it can help: cleanup is enabled (RECIPE_TEXT_CLEANUP_ENABLED
 * and a Gemini key), an LLM provider is active (the admin switch is not "none"), the text shows
 * an artifact worth fixing, and the request has time left for it.
 */
const cleanNormalizedExtraction = async (
  normalized: NormalizedExtraction,
  context: ExtractionContext
): Promise<{
  normalized: NormalizedExtraction;
  textCleanup: NonNullable<ExtractionLogContext["textCleanup"]>;
}> => {
  const { runtime, deadline } = context;
  const cleaner = runtime.recipeTextCleaner;

  if (!cleaner?.available || runtime.fallbackExtractor.providerName === "none") {
    return { normalized, textCleanup: "disabled" };
  }

  if (!recipeNeedsTextCleanup(normalized.recipe)) {
    return { normalized, textCleanup: "not_needed" };
  }

  const timeoutMs = deadline.budgetMs(textCleanupMaxMs, textCleanupReserveMs);

  if (timeoutMs < minimumTextCleanupBudgetMs) {
    return { normalized, textCleanup: "skipped_budget" };
  }

  await ensureAuthorized(context);

  return {
    normalized: {
      ...normalized,
      recipe: await cleaner.clean(normalized.recipe, { signal: deadline.signal, timeoutMs })
    },
    textCleanup: "applied"
  };
};

const scheduleCacheWrite = (
  context: ExtractionContext,
  requestUrl: string,
  response: ExtractRecipeResponse,
  sourceDocument: SourceDocument,
  detection: DetectionResult
): Promise<void> => {
  const cache = context.runtime.extractionCache;

  if (!cache || context.cacheMode === "bypass" || response.status !== "success") {
    return Promise.resolve();
  }

  return context.afterResponse(async () => {
    await cache.write({
      response,
      requestUrl,
      finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
      statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
      detectionConfidence: detection.confidence
    });
  });
};

/* Unsupported social/video links can never be cached, so they skip the lookup. */
const isCacheLookupEnabled = (context: ExtractionContext, initialDetection: DetectionResult) =>
  Boolean(context.runtime.extractionCache) &&
  context.cacheMode === "default" &&
  !isUnsupportedInitialSource(initialDetection.sourceType);

const readCachedExtraction = async (
  context: ExtractionContext,
  url: string
): Promise<CachedExtraction | null> => {
  const cache = context.runtime.extractionCache;

  if (!cache) {
    return null;
  }

  try {
    return await cache.read(url);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "extract_cache_read_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
    return null;
  }
};

/*
 * A cache hit is served as-is apart from per-request fields: the recipe's
 * sourceUrl is the URL this caller asked for (the saved-recipe id is derived
 * from it), and the log context describes this request.
 */
const buildCacheHitResult = (
  request: ExtractRecipeUrlRequest,
  cached: CachedExtraction,
  runtime: ExtractorRuntime,
  hostname: string
): ExtractionResult => {
  const response = extractRecipeResponseSchema.parse({
    ...cached.response,
    recipe: {
      ...cached.response.recipe,
      sourceUrl: request.url
    }
  } satisfies ExtractRecipeSuccess);
  const extraction = cached.response.extraction;

  return {
    response,
    logContext: {
      ...makeLogContext({
        hostname,
        detection: {
          sourceType: extraction.sourceType,
          confidence: cached.detectionConfidence,
          reasons: ["Served from the extraction result cache."],
          adapterKey: null
        },
        attempt: request.attempt,
        response,
        strategy: extraction.strategy,
        fetchMode: extraction.fetchMode,
        fallbackProvider: runtime.fallbackExtractor.providerName,
        statusCode: cached.statusCode,
        finalUrl: cached.finalUrl,
        blockedSignals: [],
        browserAttempted: false
      }),
      cacheStatus: "hit"
    }
  };
};

const noRecipeInTextResponse = (userMessage: string): ExtractRecipeResponse =>
  extractRecipeResponseSchema.parse({
    status: "failure",
    reason: "parse_failed",
    userMessage,
    recovery: noRecipeRecovery
  });

const loadTextRecipeExtractor = async () => {
  const module = await import("../extractors/text/extract-text-recipe.js");
  return module.extractTextRecipe;
};

/*
 * Text that did not come from a fetched page: a TikTok caption or pasted text. The recipe is
 * read from the text's own headings or layout (see parse-recipe-text.ts); text without a clear
 * ingredient list fails with a message that says what to add.
 */
const runTextExtraction = async ({
  context,
  document,
  detection,
  hostname,
  attempt
}: {
  context: ExtractionContext;
  document: TextSourceDocument;
  detection: DetectionResult;
  hostname: string;
  attempt: "primary" | "fallback";
}): Promise<ExtractionResult> => {
  const { runtime } = context;
  const logBase = {
    hostname,
    detection,
    attempt,
    fetchMode: "http" as const,
    fallbackProvider: runtime.fallbackExtractor.providerName,
    browserAttempted: false
  };

  await ensureAuthorized(context);

  const extraction = (await loadTextRecipeExtractor())(document);
  const normalized = extraction
    ? normalizeExtractionCandidate(
        {
          ...extraction.candidate,
          signals: { ...extraction.candidate.signals, detectionConfidence: detection.confidence }
        },
        detection.sourceType,
        document.url,
        "http"
      )
    : null;

  if (!normalized) {
    const isCaption = document.origin === "tiktok";
    const response = noRecipeInTextResponse(
      isCaption
        ? "That video's caption doesn't include a written recipe. Try the recipe's website instead."
        : looksLikeRecipeText(document.text)
          ? 'LinkDish couldn\'t tell the ingredients from the steps. Put the ingredients under an "Ingredients" heading and the steps under a "Method" heading, then try again.'
          : "That text doesn't look like a recipe yet. Include the ingredients and the steps."
    );

    return { response, logContext: makeLogContext({ ...logBase, response, strategy: "none" }) };
  }

  const response = extractRecipeResponseSchema.parse({
    status: "success",
    recipe: normalized.recipe,
    extraction: {
      sourceType: detection.sourceType,
      strategy: normalized.strategy,
      confidenceScore: normalized.confidenceScore,
      missingFields: normalized.missingFields,
      warnings: normalized.warnings,
      fetchMode: normalized.fetchMode,
      provenance: normalized.provenance
    }
  });

  return {
    response,
    logContext: makeLogContext({ ...logBase, response, strategy: normalized.strategy })
  };
};

/* TikTok: the caption is read through oEmbed and parsed like pasted text. */
const extractFromSocialCaption = async (
  request: ExtractRecipeUrlRequest,
  context: ExtractionContext,
  hostname: string,
  detection: DetectionResult
): Promise<ExtractionResult> => {
  const { runtime } = context;
  const logBase = {
    hostname,
    detection,
    attempt: request.attempt,
    fallbackProvider: runtime.fallbackExtractor.providerName,
    browserAttempted: false
  };
  const fetchSocialDocument = runtime.fetchSocialDocument;
  let document: TextSourceDocument;

  try {
    if (!fetchSocialDocument) {
      throw new SocialFetchError("Social captions are not available.", "unreachable");
    }

    document = await fetchSocialDocument(request.url, { deadline: context.deadline });
  } catch (error) {
    const response = mapFetchErrorToResponse(error, detection.sourceType);
    const metadata = getFetchErrorMetadata(error);

    return {
      response,
      logContext: makeLogContext({
        ...logBase,
        response,
        strategy: "none",
        fetchMode: "none",
        statusCode: metadata.statusCode
      })
    };
  }

  return runTextExtraction({
    context,
    document,
    detection,
    hostname,
    attempt: request.attempt
  });
};

/* Social, video and unknown links are answered from the URL alone, before anything is fetched. */
const rejectUnsupportedSource = (
  request: ExtractRecipeUrlRequest,
  context: ExtractionContext,
  hostname: string,
  detection: DetectionResult
): ExtractionResult | null => {
  const sourceType = detection.sourceType;

  if (!isUnsupportedInitialSource(sourceType)) {
    return null;
  }

  const response = extractRecipeResponseSchema.parse({
    status: "failure",
    reason: "unsupported_source",
    userMessage: unsupportedSourceMessages[sourceType],
    recovery: {
      retryable: false,
      allowFallback: false,
      suggestedAction: "try_another_url"
    }
  });

  return {
    response,
    logContext: makeLogContext({
      hostname,
      detection,
      attempt: request.attempt,
      response,
      strategy: "none",
      fetchMode: "none",
      fallbackProvider: context.runtime.fallbackExtractor.providerName,
      browserAttempted: false
    })
  };
};

/* Linked recipe pages are only tried while this much of the request budget is left. */
const minimumLinkedPageBudgetMs = 4_000;

/**
 * Reads the written recipe a YouTube description links to ("Full recipe: https://..."). Each
 * link is validated like a user URL and must be an ordinary web page; the first one whose page
 * yields a recipe wins. The recipe keeps the video as its videoUrl. Returns null when no link
 * yields one, so the description's own result (or failure) stands.
 */
const extractFromYouTubeRecipeLinks = async (
  request: ExtractRecipeUrlRequest,
  context: ExtractionContext,
  hostname: string,
  video: YouTubeSourceDocument
): Promise<ExtractionResult | null> => {
  const { findYouTubeRecipeLinks } = await loadYouTubeExtractorModule();
  const videoUrl = toYouTubeWatchUrl(video.videoId);

  for (const link of findYouTubeRecipeLinks(video)) {
    if (context.deadline.remainingMs() < minimumLinkedPageBudgetMs) {
      return null;
    }

    const linkDetection = detectSourceTypeFromUrl(link);

    if (linkDetection.sourceType !== "recipe-webpage" && linkDetection.sourceType !== "article") {
      continue;
    }

    if (isSourceUrlRejection(await context.runtime.validateSourceUrl(link))) {
      continue;
    }

    let fetched: FetchedSource;

    try {
      fetched = await fetchSourceDocument(link, linkDetection, context);
    } catch (error) {
      if (error instanceof ExtractionCancelledError) {
        throw error;
      }

      continue;
    }

    if (await detectFetchedDocumentFailure(link, fetched.sourceDocument)) {
      continue;
    }

    const linkRequest: ExtractRecipeUrlRequest = { ...request, url: link };
    const candidate = await runDeterministicExtraction(
      fetched.sourceDocument,
      fetched.detection,
      fetched.fetchMode
    );
    const decision = decidePrimaryOutcome(
      linkRequest,
      fetched.detection,
      fetched.fetchMode,
      candidate
    );

    if (decision.kind !== "success") {
      continue;
    }

    /* Not cached: the linked page's own cache entry should not carry this video. */
    const response = extractRecipeResponseSchema.parse(
      asApiResponse({
        ...decision,
        result: {
          ...decision.result,
          recipe: {
            ...decision.result.recipe,
            videoUrl: decision.result.recipe.videoUrl ?? videoUrl
          }
        }
      })
    );

    return {
      response,
      logContext: makeLogContext({
        hostname,
        detection: fetched.detection,
        attempt: request.attempt,
        response,
        strategy: decision.result.strategy,
        fetchMode: decision.result.fetchMode,
        fallbackProvider: context.runtime.fallbackExtractor.providerName,
        ...getDocumentLogFields(fetched.sourceDocument, fetched.fetchMode)
      })
    };
  }

  return null;
};

const extractFromUrl = async (
  request: ExtractRecipeUrlRequest,
  context: ExtractionContext
): Promise<ExtractionResult> => {
  const { runtime } = context;
  const initialDetection = detectSourceTypeFromUrl(request.url);
  const hostname = new URL(request.url).hostname;
  const cacheLookupEnabled = isCacheLookupEnabled(context, initialDetection);

  /* URL safety (DNS) and the cache lookup are independent. */
  const validation = runtime.validateSourceUrl(request.url);
  const cacheLookup = cacheLookupEnabled
    ? readCachedExtraction(context, request.url)
    : Promise.resolve(null);

  void validation.catch(() => undefined);

  const cached = await cacheLookup;

  if (cached) {
    return buildCacheHitResult(request, cached, runtime, hostname);
  }

  const sourceUrlSafety = await validation;

  if (isSourceUrlRejection(sourceUrlSafety)) {
    const isReachabilityFailure = sourceUrlSafety.reason === "dns_lookup_failed";
    const response = extractRecipeResponseSchema.parse({
      status: "failure",
      reason: isReachabilityFailure ? "source_unreachable" : "unsupported_source",
      userMessage: isReachabilityFailure
        ? "We could not reach that source right now."
        : "That link type is not supported yet.",
      recovery: {
        retryable: isReachabilityFailure,
        allowFallback: false,
        suggestedAction: isReachabilityFailure ? "retry_primary" : "try_another_url"
      }
    });

    return {
      response,
      logContext: makeLogContext({
        hostname,
        detection: {
          ...initialDetection,
          reasons: [...initialDetection.reasons, `Rejected unsafe URL: ${sourceUrlSafety.reason}`]
        },
        attempt: request.attempt,
        response,
        strategy: "none",
        fetchMode: "none",
        fallbackProvider: runtime.fallbackExtractor.providerName,
        browserAttempted: false
      })
    };
  }

  if (isSupportedSocialSource(initialDetection, runtime)) {
    return extractFromSocialCaption(request, context, hostname, initialDetection);
  }

  const unsupportedSource = rejectUnsupportedSource(request, context, hostname, initialDetection);

  if (unsupportedSource) {
    return unsupportedSource;
  }

  const fetchFailureResult = (
    error: unknown,
    detection: DetectionResult = initialDetection
  ): ExtractionResult => {
    /* Billing denied the request while a browser render waited for it: that is no fetch error. */
    if (error instanceof ExtractionCancelledError) {
      throw error;
    }

    const response = mapFetchErrorToResponse(error, detection.sourceType);
    const metadata = getFetchErrorMetadata(error);

    return {
      response,
      logContext: makeLogContext({
        hostname,
        detection,
        attempt: request.attempt,
        response,
        strategy: "none",
        fetchMode: "none",
        fallbackProvider: runtime.fallbackExtractor.providerName,
        statusCode: metadata.statusCode,
        finalUrl: metadata.finalUrl,
        blockedSignals: metadata.blockedSignals,
        browserAttempted: metadata.browserAttempted
      })
    };
  };

  let fetchedSource: FetchedSource;

  try {
    fetchedSource = await fetchSourceDocument(request.url, initialDetection, context);
  } catch (error) {
    return fetchFailureResult(error);
  }

  /* The fetch may start while billing is still deciding; nothing after it does. */
  await ensureAuthorized(context);

  const pinOutboundUrl = await readPinterestOutboundUrl(fetchedSource, context);

  if (pinOutboundUrl) {
    /*
     * The pin's link takes the same path a direct link to it would: YouTube through its
     * transcript, TikTok through its caption, other social and video sites are rejected
     * before anything is fetched, and web pages are fetched as HTML.
     */
    const outboundRequest: ExtractRecipeUrlRequest = { ...request, url: pinOutboundUrl };
    const outboundDetection = detectSourceTypeFromUrl(pinOutboundUrl);

    if (isSupportedSocialSource(outboundDetection, runtime)) {
      return extractFromSocialCaption(outboundRequest, context, hostname, outboundDetection);
    }

    const unsupportedOutbound = rejectUnsupportedSource(
      outboundRequest,
      context,
      hostname,
      outboundDetection
    );

    if (unsupportedOutbound) {
      return unsupportedOutbound;
    }

    /* The pin's recipe page may already be cached from a direct import. */
    const cached = isCacheLookupEnabled(context, outboundDetection)
      ? await readCachedExtraction(context, pinOutboundUrl)
      : null;

    if (cached) {
      return buildCacheHitResult(outboundRequest, cached, runtime, hostname);
    }

    try {
      fetchedSource = await fetchSourceDocument(pinOutboundUrl, outboundDetection, context);
    } catch (error) {
      return fetchFailureResult(error, outboundDetection);
    }
  }

  const { sourceDocument, fetchMode, detection } = fetchedSource;
  /* The page actually extracted: the requested URL, or the recipe a Pinterest pin links to. */
  const sourceRequest: ExtractRecipeUrlRequest = { ...request, url: fetchedSource.sourceUrl };
  const documentLogFields = getDocumentLogFields(sourceDocument, fetchMode);
  const fetchedDocumentFailure = await detectFetchedDocumentFailure(
    sourceRequest.url,
    sourceDocument
  );

  if (fetchedDocumentFailure) {
    return {
      response: fetchedDocumentFailure,
      logContext: makeLogContext({
        hostname,
        detection,
        attempt: request.attempt,
        response: fetchedDocumentFailure,
        strategy: "none",
        fetchMode,
        fallbackProvider: runtime.fallbackExtractor.providerName,
        ...documentLogFields
      })
    };
  }

  const candidate = await runDeterministicExtraction(sourceDocument, detection, fetchMode);
  const decision = decidePrimaryOutcome(sourceRequest, detection, fetchMode, candidate);

  /*
   * A video whose description has no full recipe (none, or the ingredients without a method)
   * often links to the written one; that page is read like a direct link to it.
   */
  if (
    sourceDocument.kind === "youtube" &&
    (decision.kind !== "success" || candidate?.signals.requiredFieldsInferred === true)
  ) {
    const linked = await extractFromYouTubeRecipeLinks(request, context, hostname, sourceDocument);

    if (linked) {
      return linked;
    }
  }

  const response = extractRecipeResponseSchema.parse(asApiResponse(decision));

  if (response.status === "success") {
    await scheduleCacheWrite(context, sourceRequest.url, response, sourceDocument, detection);
  }

  return {
    response,
    logContext: makeLogContext({
      hostname,
      detection,
      attempt: request.attempt,
      response,
      strategy: response.status === "success" ? response.extraction.strategy : "none",
      fetchMode: response.status === "success" ? response.extraction.fetchMode : fetchMode,
      fallbackProvider: runtime.fallbackExtractor.providerName,
      ...documentLogFields
    })
  };
};

export const extractRecipeFromUrl = async (
  request: ExtractRecipeUrlRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime(),
  options: ExtractRecipeOptions = {}
): Promise<ExtractionResult> => {
  const { context, dispose } = createExtractionContext(runtime, options);
  const cacheStatus: NonNullable<ExtractionLogContext["cacheStatus"]> = isCacheLookupEnabled(
    context,
    detectSourceTypeFromUrl(request.url)
  )
    ? "miss"
    : "bypass";

  try {
    const result = await extractFromUrl(request, context);

    return {
      ...result,
      logContext: {
        ...result.logContext,
        cacheStatus: result.logContext.cacheStatus ?? cacheStatus
      }
    };
  } finally {
    dispose();
  }
};

const imageDetection: DetectionResult = {
  sourceType: "image",
  confidence: "high",
  reasons: ["User supplied recipe image scan."],
  adapterKey: null
};

const buildImageFailureResponse = (
  reason: "fallback_unavailable" | "fallback_failed" | "quota_exceeded",
  userMessage: string
): ExtractRecipeResponse =>
  extractRecipeResponseSchema.parse({
    status: "failure",
    reason,
    userMessage,
    recovery: {
      retryable: reason === "quota_exceeded",
      allowFallback: false,
      suggestedAction: reason === "quota_exceeded" ? "try_again_later" : "try_another_url"
    }
  });

const extractFromImages = async (
  request: ExtractRecipeImageRequest,
  context: ExtractionContext
): Promise<ExtractionResult> => {
  const { runtime } = context;
  const sourceDocument: SourceDocument = {
    kind: "image",
    url: request.sourceUrl,
    images: request.images
  };
  const hostname = new URL(request.sourceUrl).hostname;

  await refreshFallbackSettings(runtime);

  const baseLogContext = {
    hostname,
    detection: imageDetection,
    attempt: request.attempt,
    fetchMode: "http" as const,
    fallbackProvider: runtime.fallbackExtractor.providerName,
    browserAttempted: false
  };

  if (!runtime.fallbackExtractor.available) {
    const response = buildImageFailureResponse(
      "fallback_unavailable",
      "Recipe image scanning is unavailable until backend vision credentials are configured."
    );

    return {
      response,
      logContext: makeLogContext({
        ...baseLogContext,
        response,
        strategy: "none"
      })
    };
  }

  await ensureAuthorized(context);

  try {
    const fallbackCandidate = await runtime.fallbackExtractor.extract({
      url: request.sourceUrl,
      sourceType: "image",
      sourceDocument,
      candidate: null,
      detection: imageDetection,
      fetchMode: "http",
      deadline: context.deadline
    });

    if (!fallbackCandidate) {
      const response = buildImageFailureResponse(
        "fallback_failed",
        "LinkDish could not read a reliable recipe from those images."
      );

      return {
        response,
        logContext: makeLogContext({
          ...baseLogContext,
          response,
          strategy: "none"
        })
      };
    }

    const normalized = normalizeExtractionCandidate(
      {
        ...fallbackCandidate,
        signals: {
          ...fallbackCandidate.signals,
          detectionConfidence: imageDetection.confidence,
          usedBrowserFallback: false,
          blockedSourceSignals: 0
        }
      },
      "image",
      request.sourceUrl,
      "http"
    );

    if (!normalized) {
      const response = buildImageFailureResponse(
        "fallback_failed",
        "LinkDish still missed required recipe details from those images."
      );

      return {
        response,
        logContext: makeLogContext({
          ...baseLogContext,
          response,
          strategy: "llm-fallback"
        })
      };
    }

    const cleanup = await cleanNormalizedExtraction(normalized, context);
    const cleanedNormalized = cleanup.normalized;
    const response = extractRecipeResponseSchema.parse({
      status: "success",
      recipe: cleanedNormalized.recipe,
      extraction: {
        sourceType: "image",
        strategy: cleanedNormalized.strategy,
        confidenceScore: cleanedNormalized.confidenceScore,
        missingFields: cleanedNormalized.missingFields,
        warnings: cleanedNormalized.warnings,
        fetchMode: cleanedNormalized.fetchMode,
        provenance: cleanedNormalized.provenance
      }
    });

    return {
      response,
      logContext: makeLogContext({
        ...baseLogContext,
        response,
        strategy: cleanedNormalized.strategy,
        textCleanup: cleanup.textCleanup
      })
    };
  } catch (error) {
    if (error instanceof ExtractionCancelledError) {
      throw error;
    }

    const reason =
      error instanceof FallbackProviderError && error.reason === "quota_exceeded"
        ? "quota_exceeded"
        : "fallback_failed";
    const response = buildImageFailureResponse(
      reason,
      reason === "quota_exceeded"
        ? "Recipe image scanning is temporarily unavailable."
        : "Recipe image scanning failed unexpectedly."
    );

    return {
      response,
      logContext: makeLogContext({
        ...baseLogContext,
        response,
        strategy: "none"
      })
    };
  }
};

/* Image scans are per-user uploads: they never read or write the result cache. */
export const extractRecipeFromImages = async (
  request: ExtractRecipeImageRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime(),
  options: ExtractRecipeOptions = {}
): Promise<ExtractionResult> => {
  const { context, dispose } = createExtractionContext(runtime, {
    ...options,
    cacheMode: "bypass"
  });

  try {
    const result = await extractFromImages(request, context);
    return {
      ...result,
      logContext: { ...result.logContext, cacheStatus: "bypass" }
    };
  } finally {
    dispose();
  }
};

const textImportSourceUrlPrefix = "https://linkdish.app/text-imports/";

/**
 * Pasted text without a source gets a stable synthetic URL derived from the text, so the same
 * paste maps to the same saved-recipe id (the way image scans use linkdish.app/image-imports/).
 */
export const buildTextImportSourceUrl = (text: string): string =>
  `${textImportSourceUrlPrefix}${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;

/* A pasted caption's link keeps its platform type; other links are web pages. */
const getTextImportSourceType = (sourceUrl: string | undefined): SourceType =>
  sourceUrl ? (detectHostedMediaSourceType(sourceUrl)?.sourceType ?? "article") : "unknown";

const extractFromText = async (
  request: TextImportRequest,
  context: ExtractionContext
): Promise<ExtractionResult> => {
  const sourceUrl = request.sourceUrl ?? buildTextImportSourceUrl(request.text);
  const detection: DetectionResult = {
    sourceType: getTextImportSourceType(request.sourceUrl),
    confidence: "high",
    reasons: ["User pasted recipe text."],
    adapterKey: null
  };
  const hostname = new URL(sourceUrl).hostname;

  return runTextExtraction({
    context,
    document: {
      kind: "text",
      url: sourceUrl,
      origin: "paste",
      text: request.text,
      title: null,
      authorName: null,
      thumbnailUrl: null
    },
    detection,
    hostname,
    attempt: "primary"
  });
};

/* Pasted text is per-user input: it never reads or writes the result cache. */
export const extractRecipeFromText = async (
  request: TextImportRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime(),
  options: ExtractRecipeOptions = {}
): Promise<ExtractionResult> => {
  const { context, dispose } = createExtractionContext(runtime, {
    ...options,
    cacheMode: "bypass"
  });

  try {
    const result = await extractFromText(request, context);
    return {
      ...result,
      logContext: { ...result.logContext, cacheStatus: "bypass" }
    };
  } finally {
    dispose();
  }
};

export const extractRecipe = (
  request: ExtractRecipeAnyRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime(),
  options: ExtractRecipeOptions = {}
) => {
  if (
    "images" in request &&
    Array.isArray(request.images) &&
    typeof request.sourceUrl === "string"
  ) {
    return extractRecipeFromImages(
      {
        attempt: "fallback",
        images: request.images,
        sourceUrl: request.sourceUrl
      },
      runtime,
      options
    );
  }

  if ("url" in request && typeof request.url === "string") {
    return extractRecipeFromUrl(
      {
        attempt: request.attempt ?? "primary",
        url: request.url
      },
      runtime,
      options
    );
  }

  if ("text" in request && typeof request.text === "string") {
    return extractRecipeFromText(
      {
        text: request.text,
        ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {})
      },
      runtime,
      options
    );
  }

  throw new Error("Invalid extract request.");
};
