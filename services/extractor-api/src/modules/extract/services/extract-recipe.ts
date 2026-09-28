import { createHash } from "node:crypto";

import {
  extractRecipeResponseSchema,
  type ExtractRecipeAnyRequest,
  type ExtractRecipeImage,
  type ExtractRecipeResponse,
  type ExtractRecipeSuccess
} from "../../../../../../packages/api-contracts/src/index.js";
import {
  buildMissingFieldSummary,
  computeMissingRecipeFields,
  hasRequiredRecipeFields,
  type Recipe,
  type SourceType
} from "../../../../../../packages/recipe-domain/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { toHandoffSourceDocument, type FallbackHandoff } from "../cache/fallback-handoff.js";
import { isStrongStructuredCandidate } from "../confidence/score-recipe.js";
import { successConfidenceThresholds } from "../confidence/thresholds.js";
import {
  createRequestDeadline,
  ExtractionCancelledError,
  type RequestDeadline
} from "../deadline.js";
import { looksLikeRecipeText } from "../extractors/recipe-text-signals.js";
import { FallbackProviderError } from "../fallback/errors.js";
import { loadFallbackInputBuilder } from "../fallback/load-fallback-input.js";
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
  ExtractionRetryReason,
  ExtractorRuntime,
  HtmlSourceDocument,
  NormalizedExtraction,
  SourceDocument,
  TextSourceDocument
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
  /** The client's import correlation id; keys the primary-to-fallback hand-off. */
  correlationId?: string;
  /**
   * "default" reads and writes the result cache, "refresh" skips reads but
   * stores fresh results (the live canary), "bypass" does neither.
   */
  cacheMode?: "default" | "refresh" | "bypass";
  /**
   * Keeps work alive past the response (cache writes, and a hand-off write that outlasts its
   * pre-response wait); Vercel passes waitUntil. Without it that work is awaited inline.
   */
  schedule?: (task: Promise<unknown>) => void;
}

interface ExtractionContext {
  runtime: ExtractorRuntime;
  deadline: RequestDeadline;
  authorization: Promise<boolean>;
  correlationId: string | undefined;
  cacheMode: NonNullable<ExtractRecipeOptions["cacheMode"]>;
  /** Starts `task` and lets it finish after the response. Never rejects. */
  afterResponse(task: () => Promise<void>): Promise<void>;
  /**
   * Starts `task` and waits at most `maxWaitMs` for it; a slower task finishes after the
   * response, like `afterResponse` work. Never rejects: a failed task reads as "settled".
   */
  beforeResponse(
    task: () => Promise<void>,
    options: { maxWaitMs: number; failureEvent: string }
  ): Promise<"settled" | "timed_out">;
}

/*
 * How long a needs_retry answer waits for its fallback hand-off to be stored. Clients may send
 * the fallback attempt the moment the primary answer arrives (the import queue does), so a
 * hand-off still being written then is missed and the page is fetched (often rendered) again.
 * Storing it takes a lazily loaded HTML summary pass and one store write: typically tens of
 * milliseconds, a few hundred on a cold start with a large page. 400 ms covers that tail while
 * staying well under the store's own 1.5 s request timeout, so a slow or failing store adds at
 * most 400 ms to an answer whose next step is a multi-second LLM call. A write that takes longer
 * keeps running after the response, as it did before, and usually still lands before the
 * fallback attempt (a new request, rate-limited and billed first) reads it.
 */
export const FALLBACK_HANDOFF_MAX_WAIT_MS = 400;

const logTaskFailure = (event: string) => (error: unknown) => {
  console.warn(
    JSON.stringify({
      event,
      message: error instanceof Error ? error.message : "Unknown error"
    })
  );
};

/* Resolves true when `task` settles within `maxWaitMs`, false when the wait ran out first. */
const settlesWithin = async (task: Promise<void>, maxWaitMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, maxWaitMs));
  });

  try {
    return await Promise.race([task.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const defaultRetryRecovery = {
  retryable: true,
  allowFallback: true,
  suggestedAction: "retry_fallback"
} as const;

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
      correlationId: options.correlationId,
      cacheMode: options.cacheMode ?? "default",
      afterResponse: async (task) => {
        const guardedTask = task().catch(logTaskFailure("extract_post_response_task_failed"));

        if (!keepAlive(guardedTask)) {
          await guardedTask;
        }
      },
      beforeResponse: async (task, { maxWaitMs, failureEvent }) => {
        const guardedTask = task().catch(logTaskFailure(failureEvent));

        /* Scheduled first, so the task outlives the response if the wait below runs out. */
        if (!keepAlive(guardedTask)) {
          await guardedTask;
          return "settled";
        }

        return (await settlesWithin(guardedTask, maxWaitMs)) ? "settled" : "timed_out";
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

const buildRetryDecision = (
  sourceType: SourceType,
  candidate: ExtractionCandidate | null,
  confidenceScore: number,
  reason: ExtractionRetryReason,
  userMessage: string
): DeterministicDecision => ({
  kind: "needs_retry",
  reason,
  sourceType,
  userMessage,
  diagnostics: {
    confidenceScore,
    missingFields: computeMissingRecipeFields(candidate?.recipe ?? {})
  },
  candidate,
  recovery: defaultRetryRecovery
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
  textCleanup,
  fallbackHandoff
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
  fallbackHandoff?: ExtractionLogContext["fallbackHandoff"];
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
  ...(textCleanup ? { textCleanup } : {}),
  ...(fallbackHandoff ? { fallbackHandoff } : {})
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

const loadYouTubeExtractor = async () => {
  const module = await import("../extractors/youtube/extract-youtube-recipe.js");
  return module.extractYouTubeRecipe;
};

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
      extractYouTubeRecipe(sourceDocument),
      detection,
      fetchMode,
      sourceDocument
    );
  }

  return null;
};

const decidePrimaryOutcome = (
  request: ExtractRecipeUrlRequest,
  detection: DetectionResult,
  sourceDocument: SourceDocument,
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
    if (
      sourceType === "youtube" &&
      sourceDocument.kind === "youtube" &&
      !sourceDocument.transcript
    ) {
      return buildRetryDecision(
        sourceType,
        null,
        0,
        "transcript_required",
        "A transcript is required before we can reliably extract this YouTube recipe."
      );
    }

    return buildFailureDecision(
      "parse_failed",
      "We could not identify recipe signals from this source.",
      {
        retryable: false,
        allowFallback: false,
        suggestedAction: "try_another_url"
      }
    );
  }

  const normalized = normalizeExtractionCandidate(candidate, sourceType, request.url, fetchMode);
  const missingFields = computeMissingRecipeFields(candidate.recipe);

  if (!hasRequiredRecipeFields(candidate.recipe)) {
    return buildRetryDecision(
      sourceType,
      candidate,
      normalized?.confidenceScore ?? 0,
      "missing_required_fields",
      buildMissingFieldSummary(candidate.recipe)
    );
  }

  if (!normalized) {
    return buildRetryDecision(
      sourceType,
      candidate,
      0,
      "missing_required_fields",
      "Required recipe fields were missing after normalization."
    );
  }

  /*
   * A site's own Recipe JSON-LD/microdata with a title, ingredients and steps is a success even
   * when servings or times are missing (the normaliser notes the gaps as a warning).
   */
  if (
    normalized.confidenceScore < successConfidenceThresholds[sourceType] &&
    !isStrongStructuredCandidate(candidate)
  ) {
    return buildRetryDecision(
      sourceType,
      candidate,
      normalized.confidenceScore,
      sourceType === "youtube" &&
        sourceDocument.kind === "youtube" &&
        !sourceDocument.transcript &&
        !candidate.provenance.includes("transcript")
        ? "transcript_required"
        : "low_confidence",
      "We found recipe details, but they are not reliable enough yet."
    );
  }

  return {
    kind: "success",
    result: {
      ...normalized,
      missingFields
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

  if (decision.kind === "needs_retry") {
    return {
      status: "needs_retry",
      reason: decision.reason,
      sourceType: decision.sourceType,
      suggestedAttempt: "fallback",
      userMessage: decision.userMessage,
      diagnostics: decision.diagnostics,
      recovery: decision.recovery
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
 * The Gemini cleanup pass is a second LLM call, so it only runs when it can
 * help: cleanup is enabled (RECIPE_TEXT_CLEANUP_ENABLED and a Gemini key), an
 * LLM provider is active (the admin switch is not "none"), the text shows an
 * artifact worth fixing, and the request has time left for it.
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

/*
 * Stores the hand-off before the needs_retry answer goes out (bounded by
 * FALLBACK_HANDOFF_MAX_WAIT_MS and the request deadline), so a fallback attempt sent the moment
 * that answer arrives finds it. With the fallback provider switched off the fallback attempt
 * never reads one, so nothing is stored or waited for.
 */
const persistFallbackHandoff = async (
  context: ExtractionContext,
  requestUrl: string,
  sourceUrl: string,
  sourceDocument: SourceDocument,
  detection: DetectionResult,
  fetchMode: FetchMode,
  candidate: ExtractionCandidate | null
): Promise<void> => {
  const store = context.runtime.fallbackHandoffStore;
  const correlationId = context.correlationId;

  if (
    !store ||
    !correlationId ||
    !context.runtime.fallbackExtractor.available ||
    sourceDocument.kind === "image" ||
    sourceDocument.kind === "text"
  ) {
    return;
  }

  const maxWaitMs = context.deadline.budgetMs(FALLBACK_HANDOFF_MAX_WAIT_MS);
  const outcome = await context.beforeResponse(
    async () => {
      const sourceSummary =
        sourceDocument.kind === "html"
          ? (await loadFallbackInputBuilder()).buildHtmlSourceSummary(sourceDocument.html)
          : null;
      const handoff: FallbackHandoff = {
        url: requestUrl,
        detection,
        fetchMode,
        candidate,
        sourceDocument: toHandoffSourceDocument(sourceDocument),
        sourceSummary,
        ...(sourceUrl === requestUrl ? {} : { sourceUrl })
      };

      await store.write(correlationId, requestUrl, handoff);
    },
    { maxWaitMs, failureEvent: "extract_handoff_write_failed" }
  );

  if (outcome === "timed_out") {
    console.warn(
      JSON.stringify({
        event: "extract_handoff_write_slow",
        waitedMs: maxWaitMs
      })
    );
  }
};

const readFallbackHandoff = async (
  context: ExtractionContext,
  url: string
): Promise<FallbackHandoff | null> => {
  const store = context.runtime.fallbackHandoffStore;

  if (!store || !context.correlationId) {
    return null;
  }

  try {
    return await store.read(context.correlationId, url);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "extract_handoff_read_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      })
    );
    return null;
  }
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

const fallbackFailureResponse = (
  reason: "fallback_failed" | "quota_exceeded",
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

const recipeMetadataKeys = [
  "description",
  "totalTimeMinutes",
  "author",
  "siteName",
  "cuisine",
  "category",
  "keywords",
  "videoUrl"
] as const satisfies readonly (keyof Recipe)[];

/*
 * The LLM extractors return the core recipe only. Metadata the deterministic pass or the source
 * already knew (description, author, site, video...) is carried over where the model left a gap.
 */
const withMissingMetadata = (
  recipe: Partial<Recipe>,
  ...sources: Array<Partial<Recipe> | null | undefined>
): Partial<Recipe> => {
  const merged: Partial<Recipe> = { ...recipe };

  for (const key of recipeMetadataKeys) {
    if (merged[key] != null) {
      continue;
    }

    const value = sources.map((source) => source?.[key]).find((entry) => entry != null);

    if (value != null) {
      Object.assign(merged, { [key]: value });
    }
  }

  return merged;
};

/* Metadata a fetched source carries by itself: the video and channel for YouTube and TikTok. */
const sourceDocumentMetadata = (sourceDocument: SourceDocument): Partial<Recipe> => {
  if (sourceDocument.kind === "youtube") {
    return {
      siteName: "YouTube",
      videoUrl: toYouTubeWatchUrl(sourceDocument.videoId),
      ...(sourceDocument.authorName ? { author: sourceDocument.authorName } : {})
    };
  }

  if (sourceDocument.kind === "text" && sourceDocument.origin === "tiktok") {
    return {
      siteName: "TikTok",
      videoUrl: sourceDocument.url,
      ...(sourceDocument.authorName ? { author: sourceDocument.authorName } : {})
    };
  }

  return {};
};

const runUrlFallbackExtraction = async ({
  request,
  context,
  hostname,
  detection,
  fetchMode,
  sourceDocument,
  candidate,
  sourceSummary,
  fallbackHandoff
}: {
  request: ExtractRecipeUrlRequest;
  context: ExtractionContext;
  hostname: string;
  detection: DetectionResult;
  fetchMode: FetchMode;
  sourceDocument: SourceDocument;
  candidate: ExtractionCandidate | null;
  sourceSummary: string | null;
  fallbackHandoff: NonNullable<ExtractionLogContext["fallbackHandoff"]> | undefined;
}): Promise<ExtractionResult> => {
  const { runtime } = context;
  const documentLogFields = {
    ...getDocumentLogFields(sourceDocument, fetchMode),
    /* A handed-off document was fetched by the primary attempt, not by this request. */
    ...(fallbackHandoff === "used" ? { browserAttempted: false } : {})
  };
  const logBase = {
    hostname,
    detection,
    attempt: request.attempt,
    fetchMode,
    fallbackProvider: runtime.fallbackExtractor.providerName,
    ...documentLogFields,
    ...(fallbackHandoff ? { fallbackHandoff } : {})
  };

  await ensureAuthorized(context);

  try {
    const fallbackCandidate = await runtime.fallbackExtractor.extract({
      url: request.url,
      sourceType: detection.sourceType,
      sourceDocument,
      candidate,
      detection,
      fetchMode,
      ...(sourceSummary ? { sourceSummary } : {}),
      deadline: context.deadline
    });

    if (!fallbackCandidate) {
      const response = fallbackFailureResponse(
        "fallback_failed",
        "LinkDish could not build a reliable recipe from that link."
      );

      return {
        response,
        logContext: makeLogContext({ ...logBase, response, strategy: "none" })
      };
    }

    const normalized = normalizeExtractionCandidate(
      {
        ...fallbackCandidate,
        recipe: {
          ...withMissingMetadata(
            fallbackCandidate.recipe,
            candidate?.recipe,
            sourceDocumentMetadata(sourceDocument)
          ),
          image: fallbackCandidate.recipe.image ?? candidate?.recipe.image ?? null
        },
        signals: {
          ...fallbackCandidate.signals,
          usedBrowserFallback: fetchMode === "browser",
          detectionConfidence: detection.confidence
        }
      },
      detection.sourceType,
      request.url,
      fetchMode
    );

    if (!normalized) {
      const response = fallbackFailureResponse(
        "fallback_failed",
        "LinkDish still missed required recipe details from that link."
      );

      return {
        response,
        logContext: makeLogContext({ ...logBase, response, strategy: "llm-fallback" })
      };
    }

    const cleanup = await cleanNormalizedExtraction(normalized, context);
    const cleanedNormalized = cleanup.normalized;
    const response = extractRecipeResponseSchema.parse({
      status: "success",
      recipe: cleanedNormalized.recipe,
      extraction: {
        sourceType: detection.sourceType,
        strategy: cleanedNormalized.strategy,
        confidenceScore: cleanedNormalized.confidenceScore,
        missingFields: cleanedNormalized.missingFields,
        warnings: cleanedNormalized.warnings,
        fetchMode: cleanedNormalized.fetchMode,
        provenance: cleanedNormalized.provenance
      }
    });

    /*
     * LLM output is never written to the shared result cache: the model reads page text that
     * other people can post (comments, reviews), so one caller could steer what every later
     * importer of this URL is served. See extraction-cache.ts.
     */

    return {
      response,
      logContext: makeLogContext({
        ...logBase,
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
    const response = fallbackFailureResponse(
      reason,
      reason === "quota_exceeded"
        ? "Extra recipe help is temporarily unavailable."
        : "Extra recipe help failed unexpectedly."
    );

    return {
      response,
      logContext: makeLogContext({ ...logBase, response, strategy: "none" })
    };
  }
};

const fallbackUnavailableResponse = (userMessage: string): ExtractRecipeResponse =>
  extractRecipeResponseSchema.parse({
    status: "failure",
    reason: "fallback_unavailable",
    userMessage,
    recovery: {
      retryable: false,
      allowFallback: false,
      suggestedAction: "try_again_later"
    }
  });

const noRecipeInTextResponse = (userMessage: string): ExtractRecipeResponse =>
  extractRecipeResponseSchema.parse({
    status: "failure",
    reason: "parse_failed",
    userMessage,
    recovery: {
      retryable: false,
      allowFallback: false,
      suggestedAction: "try_another_url"
    }
  });

/*
 * The LLM path for text that did not come from a fetched page: a TikTok caption (on the
 * explicit fallback attempt) or pasted text. Billing treats both as strong extractions.
 */
const runTextFallbackExtraction = async ({
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
  const failure = (
    reason: "fallback_failed" | "quota_exceeded",
    userMessage: string,
    strategy: ExtractionLogContext["strategy"]
  ): ExtractionResult => {
    const response = fallbackFailureResponse(reason, userMessage);
    return { response, logContext: makeLogContext({ ...logBase, response, strategy }) };
  };

  await ensureAuthorized(context);

  try {
    const fallbackCandidate = await runtime.fallbackExtractor.extract({
      url: document.url,
      sourceType: detection.sourceType,
      sourceDocument: document,
      candidate: null,
      detection,
      fetchMode: "http",
      deadline: context.deadline
    });

    if (!fallbackCandidate) {
      return failure(
        "fallback_failed",
        "LinkDish could not build a reliable recipe from that text.",
        "none"
      );
    }

    const normalized = normalizeExtractionCandidate(
      {
        ...fallbackCandidate,
        recipe: {
          ...withMissingMetadata(fallbackCandidate.recipe, sourceDocumentMetadata(document)),
          image:
            fallbackCandidate.recipe.image ??
            (document.thumbnailUrl ? { url: document.thumbnailUrl, source: "og" } : null)
        },
        signals: {
          ...fallbackCandidate.signals,
          detectionConfidence: detection.confidence,
          usedBrowserFallback: false,
          blockedSourceSignals: 0
        }
      },
      detection.sourceType,
      document.url,
      "http"
    );

    if (!normalized) {
      return failure(
        "fallback_failed",
        "LinkDish still missed required recipe details in that text.",
        "llm-fallback"
      );
    }

    const cleanup = await cleanNormalizedExtraction(normalized, context);
    const cleanedNormalized = cleanup.normalized;
    const response = extractRecipeResponseSchema.parse({
      status: "success",
      recipe: cleanedNormalized.recipe,
      extraction: {
        sourceType: detection.sourceType,
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
        ...logBase,
        response,
        strategy: cleanedNormalized.strategy,
        textCleanup: cleanup.textCleanup
      })
    };
  } catch (error) {
    if (error instanceof ExtractionCancelledError) {
      throw error;
    }

    const quotaExceeded =
      error instanceof FallbackProviderError && error.reason === "quota_exceeded";

    return failure(
      quotaExceeded ? "quota_exceeded" : "fallback_failed",
      quotaExceeded
        ? "Extra recipe help is temporarily unavailable."
        : "Extra recipe help failed unexpectedly.",
      "none"
    );
  }
};

/*
 * TikTok: the caption is read through oEmbed. A caption with recipe signals needs the LLM, which
 * only runs on the client's explicit fallback attempt (billed as a strong extraction), so the
 * primary attempt answers needs_retry; a caption without a recipe fails without any LLM call.
 */
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

  if (request.attempt === "fallback" && !runtime.fallbackExtractor.available) {
    const response = fallbackUnavailableResponse(
      "Extra recipe help is unavailable until backend recovery credentials are configured."
    );

    return {
      response,
      logContext: makeLogContext({ ...logBase, response, strategy: "none", fetchMode: "none" })
    };
  }

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

  await ensureAuthorized(context);

  if (!looksLikeRecipeText(document.text)) {
    const response = noRecipeInTextResponse(
      "That video's caption doesn't include a recipe. Try the recipe's website instead."
    );

    return {
      response,
      logContext: makeLogContext({ ...logBase, response, strategy: "none", fetchMode: "http" })
    };
  }

  if (request.attempt === "primary") {
    const response = extractRecipeResponseSchema.parse(
      asApiResponse(
        buildRetryDecision(
          detection.sourceType,
          null,
          0,
          "unsupported_primary_extraction",
          "This video's caption has a recipe. LinkDish can read it with extra recipe help."
        )
      )
    );

    return {
      response,
      logContext: makeLogContext({ ...logBase, response, strategy: "none", fetchMode: "http" })
    };
  }

  return runTextFallbackExtraction({
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

const extractFromUrl = async (
  request: ExtractRecipeUrlRequest,
  context: ExtractionContext
): Promise<ExtractionResult> => {
  const { runtime } = context;
  const initialDetection = detectSourceTypeFromUrl(request.url);
  const hostname = new URL(request.url).hostname;
  const cacheLookupEnabled = isCacheLookupEnabled(context, initialDetection);

  /* Settings refresh, URL safety (DNS) and the cache lookup are independent. */
  const settingsRefresh = refreshFallbackSettings(runtime);
  const validation = runtime.validateSourceUrl(request.url);
  const cacheLookup = cacheLookupEnabled
    ? readCachedExtraction(context, request.url)
    : Promise.resolve(null);

  void validation.catch(() => undefined);

  const cached = await cacheLookup;

  if (cached) {
    await settingsRefresh;
    return buildCacheHitResult(request, cached, runtime, hostname);
  }

  const sourceUrlSafety = await validation;
  await settingsRefresh;

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

  const handoffConfigured = Boolean(runtime.fallbackHandoffStore && context.correlationId);

  if (request.attempt === "fallback") {
    /* Without a fallback provider there is nothing to fetch the page for. */
    if (!runtime.fallbackExtractor.available) {
      const response = extractRecipeResponseSchema.parse({
        status: "failure",
        reason: "fallback_unavailable",
        userMessage:
          "Extra recipe help is unavailable until backend recovery credentials are configured.",
        recovery: {
          retryable: false,
          allowFallback: false,
          suggestedAction: "try_again_later"
        }
      });

      return {
        response,
        logContext: makeLogContext({
          hostname,
          detection: initialDetection,
          attempt: request.attempt,
          response,
          strategy: "none",
          fetchMode: "none",
          fallbackProvider: runtime.fallbackExtractor.providerName,
          browserAttempted: false
        })
      };
    }

    const handoff = handoffConfigured ? await readFallbackHandoff(context, request.url) : null;

    if (handoff) {
      return runUrlFallbackExtraction({
        request: { ...request, url: handoff.sourceUrl ?? request.url },
        context,
        hostname,
        detection: handoff.detection,
        fetchMode: handoff.fetchMode,
        sourceDocument: handoff.sourceDocument,
        candidate: handoff.candidate,
        sourceSummary: handoff.sourceSummary,
        fallbackHandoff: "used"
      });
    }
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

  if (request.attempt === "fallback") {
    return runUrlFallbackExtraction({
      request: sourceRequest,
      context,
      hostname,
      detection,
      fetchMode,
      sourceDocument,
      candidate,
      sourceSummary: null,
      fallbackHandoff: handoffConfigured ? "missing" : undefined
    });
  }

  const decision = decidePrimaryOutcome(
    sourceRequest,
    detection,
    sourceDocument,
    fetchMode,
    candidate
  );
  const cleanup =
    decision.kind === "success" ? await cleanNormalizedExtraction(decision.result, context) : null;
  const cleanedDecision: DeterministicDecision =
    decision.kind === "success" && cleanup ? { ...decision, result: cleanup.normalized } : decision;
  const response = extractRecipeResponseSchema.parse(asApiResponse(cleanedDecision));

  if (response.status === "success") {
    await scheduleCacheWrite(context, sourceRequest.url, response, sourceDocument, detection);
  } else if (decision.kind === "needs_retry") {
    await persistFallbackHandoff(
      context,
      request.url,
      sourceRequest.url,
      sourceDocument,
      detection,
      fetchMode,
      decision.candidate
    );
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
      ...documentLogFields,
      ...(cleanup ? { textCleanup: cleanup.textCleanup } : {})
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
  const { runtime } = context;
  const sourceUrl = request.sourceUrl ?? buildTextImportSourceUrl(request.text);
  const detection: DetectionResult = {
    sourceType: getTextImportSourceType(request.sourceUrl),
    confidence: "high",
    reasons: ["User pasted recipe text."],
    adapterKey: null
  };
  const hostname = new URL(sourceUrl).hostname;

  await refreshFallbackSettings(runtime);

  const logBase = {
    hostname,
    detection,
    attempt: "fallback" as const,
    fetchMode: "http" as const,
    fallbackProvider: runtime.fallbackExtractor.providerName,
    browserAttempted: false
  };

  if (!runtime.fallbackExtractor.available) {
    const response = fallbackUnavailableResponse(
      "Importing from text is unavailable until backend recovery credentials are configured."
    );

    return { response, logContext: makeLogContext({ ...logBase, response, strategy: "none" }) };
  }

  if (!looksLikeRecipeText(request.text)) {
    const response = noRecipeInTextResponse(
      "That text doesn't look like a recipe yet. Include the ingredients and the steps."
    );

    return { response, logContext: makeLogContext({ ...logBase, response, strategy: "none" }) };
  }

  return runTextFallbackExtraction({
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
    attempt: "fallback"
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
