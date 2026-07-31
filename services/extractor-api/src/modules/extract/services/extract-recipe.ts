import {
  extractRecipeResponseSchema,
  type ExtractRecipeImage,
  type ExtractRecipeRequest,
  type ExtractRecipeResponse
} from "../../../../../../packages/api-contracts/src/index.js";
import {
  buildMissingFieldSummary,
  computeMissingRecipeFields,
  hasRequiredRecipeFields
} from "../../../../../../packages/recipe-domain/src/index.js";
import { FallbackProviderError } from "../fallback/errors.js";
import { BrowserFetchError, HtmlFetchError, YouTubeFetchError } from "../fetchers/index.js";
import {
  looksLikeNotFoundHtml,
  looksLikeNotFoundTitle,
  looksLikeUnrelatedRedirect
} from "../fetchers/shared.js";
import { normalizeExtractionCandidate } from "../normalizers/index.js";
import { detectSourceType } from "../source-detection/detect-source-type.js";
import { isSourceUrlRejection } from "../source-url-safety.js";

import { assertYouTubeVideoId, getSharedExtractorRuntime } from "./runtime.js";

import type { FetchMode } from "../../../../../../packages/api-contracts/src/index.js";
import type {
  DetectionResult,
  DeterministicDecision,
  DeterministicFailureDecision,
  ExtractionCandidate,
  ExtractionLogContext,
  ExtractionRetryReason,
  ExtractorRuntime,
  NormalizedExtraction,
  SourceDocument
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

const retryThresholds = {
  "recipe-webpage": 0.8,
  article: 0.84,
  youtube: 0.82
} as const;

const defaultRetryRecovery = {
  retryable: true,
  allowFallback: true,
  suggestedAction: "retry_fallback"
} as const;

const unsupportedSourceMessages = {
  social: "Social media links are not supported yet. Paste a written recipe page instead.",
  video: "Video links and shorts are not supported yet. Paste a written recipe page instead.",
  unknown: "That source is not supported yet."
} as const;

const isUnsupportedInitialSource = (
  sourceType: DetectionResult["sourceType"]
): sourceType is keyof typeof unsupportedSourceMessages =>
  sourceType === "social" || sourceType === "video" || sourceType === "unknown";

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
  sourceType: "recipe-webpage" | "article" | "youtube",
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
  browserAttempted
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
  browserAttempted: browserAttempted ?? fetchMode === "browser"
});

const mapFetchErrorToResponse = (
  error: unknown,
  sourceType: DetectionResult["sourceType"]
): ExtractRecipeResponse => {
  if (
    error instanceof BrowserFetchError ||
    error instanceof HtmlFetchError ||
    error instanceof YouTubeFetchError
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
            : "That site blocked recipe extraction right now.",
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
        userMessage: "That page no longer exists or has moved.",
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
    error instanceof YouTubeFetchError
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

const detectFetchedDocumentFailure = (
  requestUrl: string,
  sourceDocument: SourceDocument
): ExtractRecipeResponse | null => {
  if (sourceDocument.kind !== "html") {
    return null;
  }

  if (
    sourceDocument.statusCode === 404 ||
    sourceDocument.statusCode === 410 ||
    looksLikeNotFoundTitle(sourceDocument.title) ||
    looksLikeNotFoundHtml(sourceDocument.html)
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

const fetchSourceDocument = async (
  url: string,
  detection: DetectionResult,
  runtime: ExtractorRuntime
): Promise<{
  sourceDocument: SourceDocument;
  fetchMode: FetchMode;
  detection: DetectionResult;
}> => {
  if (detection.sourceType === "youtube") {
    const videoId = assertYouTubeVideoId(url);

    if (!videoId) {
      throw new YouTubeFetchError("Missing YouTube video id.", "unreachable");
    }

    return {
      sourceDocument: await runtime.fetchYouTubeDocument(url, videoId),
      fetchMode: "http",
      detection
    };
  }

  const fetchResult = await runtime.fetchHtmlDocument(url);
  const refinedDetection = detectSourceType(url, fetchResult.document);

  return {
    sourceDocument: fetchResult.document,
    fetchMode: fetchResult.mode,
    detection: refinedDetection
  };
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

const loadArticleExtractor = async () => {
  const module = await import("../extractors/article/extract-article-recipe.js");
  return module.extractArticleRecipe;
};

const loadYouTubeExtractor = async () => {
  const module = await import("../extractors/youtube/extract-youtube-recipe.js");
  return module.extractYouTubeRecipe;
};

const runDeterministicExtraction = async (
  sourceDocument: SourceDocument,
  detection: DetectionResult,
  fetchMode: FetchMode
): Promise<ExtractionCandidate | null> => {
  if (sourceDocument.kind === "html" && detection.sourceType === "recipe-webpage") {
    const [extractRecipeWebpage, extractArticleRecipe] = await Promise.all([
      loadRecipeWebpageExtractor(),
      loadArticleExtractor()
    ]);

    return withRuntimeSignals(
      extractRecipeWebpage(sourceDocument) ?? extractArticleRecipe(sourceDocument),
      detection,
      fetchMode,
      sourceDocument
    );
  }

  if (sourceDocument.kind === "html" && detection.sourceType === "article") {
    const [extractArticleRecipe, extractRecipeWebpage] = await Promise.all([
      loadArticleExtractor(),
      loadRecipeWebpageExtractor()
    ]);

    return withRuntimeSignals(
      extractArticleRecipe(sourceDocument) ?? extractRecipeWebpage(sourceDocument),
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

  if (normalized.confidenceScore < retryThresholds[sourceType]) {
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

const cleanNormalizedExtraction = async (
  normalized: NormalizedExtraction,
  runtime: ExtractorRuntime
): Promise<NormalizedExtraction> => {
  const cleaner = runtime.recipeTextCleaner;

  if (!cleaner?.available) {
    return normalized;
  }

  return {
    ...normalized,
    recipe: await cleaner.clean(normalized.recipe)
  };
};

export const extractRecipeFromUrl = async (
  request: ExtractRecipeUrlRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime()
): Promise<{
  response: ExtractRecipeResponse;
  logContext: Omit<ExtractionLogContext, "latencyMs">;
}> => {
  const sourceUrlSafety = await runtime.validateSourceUrl(request.url);
  const initialDetection = detectSourceType(request.url);
  const hostname = new URL(request.url).hostname;

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

  if (isUnsupportedInitialSource(initialDetection.sourceType)) {
    const response = extractRecipeResponseSchema.parse({
      status: "failure",
      reason: "unsupported_source",
      userMessage: unsupportedSourceMessages[initialDetection.sourceType],
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

  let fetchedSource: {
    sourceDocument: SourceDocument;
    fetchMode: FetchMode;
    detection: DetectionResult;
  };

  try {
    fetchedSource = await fetchSourceDocument(request.url, initialDetection, runtime);
  } catch (error) {
    const response = mapFetchErrorToResponse(error, initialDetection.sourceType);
    const metadata = getFetchErrorMetadata(error);

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
        statusCode: metadata.statusCode,
        finalUrl: metadata.finalUrl,
        blockedSignals: metadata.blockedSignals,
        browserAttempted: metadata.browserAttempted
      })
    };
  }

  const { sourceDocument, fetchMode, detection } = fetchedSource;
  const fetchedDocumentFailure = detectFetchedDocumentFailure(request.url, sourceDocument);

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
        statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
        finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
        blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
        browserAttempted: fetchMode === "browser"
      })
    };
  }

  const candidate = await runDeterministicExtraction(sourceDocument, detection, fetchMode);

  if (request.attempt === "fallback") {
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
          detection,
          attempt: request.attempt,
          response,
          strategy: "none",
          fetchMode,
          fallbackProvider: runtime.fallbackExtractor.providerName,
          statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
          finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
          blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
          browserAttempted: fetchMode === "browser"
        })
      };
    }

    try {
      const fallbackCandidate = await runtime.fallbackExtractor.extract({
        url: request.url,
        sourceType: detection.sourceType,
        sourceDocument,
        candidate,
        detection,
        fetchMode
      });

      if (!fallbackCandidate) {
        const response = extractRecipeResponseSchema.parse({
          status: "failure",
          reason: "fallback_failed",
          userMessage: "LinkDish could not build a reliable recipe from that link.",
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
            fetchMode,
            fallbackProvider: runtime.fallbackExtractor.providerName,
            statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
            finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
            blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
            browserAttempted: fetchMode === "browser"
          })
        };
      }

      const normalized = normalizeExtractionCandidate(
        {
          ...fallbackCandidate,
          recipe: {
            ...fallbackCandidate.recipe,
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
        const response = extractRecipeResponseSchema.parse({
          status: "failure",
          reason: "fallback_failed",
          userMessage: "LinkDish still missed required recipe details from that link.",
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
            strategy: "llm-fallback",
            fetchMode,
            fallbackProvider: runtime.fallbackExtractor.providerName,
            statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
            finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
            blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
            browserAttempted: fetchMode === "browser"
          })
        };
      }

      const cleanedNormalized = await cleanNormalizedExtraction(normalized, runtime);
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
          hostname,
          detection,
          attempt: request.attempt,
          response,
          strategy: cleanedNormalized.strategy,
          fetchMode,
          fallbackProvider: runtime.fallbackExtractor.providerName,
          statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
          finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
          blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
          browserAttempted: fetchMode === "browser"
        })
      };
    } catch (error) {
      const reason =
        error instanceof FallbackProviderError && error.reason === "quota_exceeded"
          ? "quota_exceeded"
          : "fallback_failed";
      const response = extractRecipeResponseSchema.parse({
        status: "failure",
        reason,
        userMessage:
          reason === "quota_exceeded"
            ? "Extra recipe help is temporarily unavailable."
            : "Extra recipe help failed unexpectedly.",
        recovery: {
          retryable: reason === "quota_exceeded",
          allowFallback: false,
          suggestedAction: reason === "quota_exceeded" ? "try_again_later" : "try_another_url"
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
          fetchMode,
          fallbackProvider: runtime.fallbackExtractor.providerName,
          statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
          finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
          blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
          browserAttempted: fetchMode === "browser"
        })
      };
    }
  }

  const decision = decidePrimaryOutcome(request, detection, sourceDocument, fetchMode, candidate);
  const cleanedDecision: DeterministicDecision =
    decision.kind === "success"
      ? {
          ...decision,
          result: await cleanNormalizedExtraction(decision.result, runtime)
        }
      : decision;
  const response = extractRecipeResponseSchema.parse(asApiResponse(cleanedDecision));

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
      statusCode: sourceDocument.kind === "html" ? sourceDocument.statusCode : null,
      finalUrl: sourceDocument.kind === "html" ? sourceDocument.finalUrl : null,
      blockedSignals: sourceDocument.kind === "html" ? sourceDocument.blockedSignals : [],
      browserAttempted: fetchMode === "browser"
    })
  };
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

export const extractRecipeFromImages = async (
  request: ExtractRecipeImageRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime()
): Promise<{
  response: ExtractRecipeResponse;
  logContext: Omit<ExtractionLogContext, "latencyMs">;
}> => {
  const sourceDocument: SourceDocument = {
    kind: "image",
    url: request.sourceUrl,
    images: request.images
  };
  const hostname = new URL(request.sourceUrl).hostname;
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

  try {
    const fallbackCandidate = await runtime.fallbackExtractor.extract({
      url: request.sourceUrl,
      sourceType: "image",
      sourceDocument,
      candidate: null,
      detection: imageDetection,
      fetchMode: "http"
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

    const cleanedNormalized = await cleanNormalizedExtraction(normalized, runtime);
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
        strategy: cleanedNormalized.strategy
      })
    };
  } catch (error) {
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

export const extractRecipe = (
  request: ExtractRecipeRequest,
  runtime: ExtractorRuntime = getSharedExtractorRuntime()
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
      runtime
    );
  }

  if ("url" in request && typeof request.url === "string") {
    return extractRecipeFromUrl(
      {
        attempt: request.attempt ?? "primary",
        url: request.url
      },
      runtime
    );
  }

  throw new Error("Invalid extract request.");
};
