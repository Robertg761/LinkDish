import type { ExtractionResultCache } from "./cache/extraction-cache.js";
import type { FallbackHandoffStore } from "./cache/fallback-handoff.js";
import type { RequestDeadline } from "./deadline.js";
import type { ValidateSourceUrl } from "./source-url-safety.js";
import type {
  ExtractRecipeImage,
  ExtractRecipeFailure,
  ExtractRecipeNeedsRetry,
  ExtractRecipeSuccess,
  ExtractionProvenance,
  FetchMode,
  ExtractionStrategy
} from "../../../../../packages/api-contracts/src/index.js";
import type {
  MissingRecipeField,
  Recipe,
  RecipeFieldProvenance,
  SourceType
} from "../../../../../packages/recipe-domain/src/index.js";

export interface HtmlSourceDocument {
  kind: "html";
  url: string;
  finalUrl: string;
  html: string;
  contentType: string | null;
  title: string | null;
  description: string | null;
  blockedSignals: string[];
  statusCode: number;
}

export interface YouTubeSourceDocument {
  kind: "youtube";
  url: string;
  videoId: string;
  title: string | null;
  description: string | null;
  transcript: string | null;
  chapters: string[];
  pageHtml: string | null;
}

export interface ImageSourceDocument {
  kind: "image";
  url: string;
  images: ExtractRecipeImage[];
}

export type SourceDocument = HtmlSourceDocument | YouTubeSourceDocument | ImageSourceDocument;

export interface FetchResult {
  document: HtmlSourceDocument;
  mode: FetchMode;
  blockedSignals: string[];
}

export type InternalFetchFailureKind =
  | "blocked"
  | "not_found"
  | "timeout"
  | "too_large"
  | "unreachable"
  | "unsupported_content_type";

export interface BrowserFetchOptions {
  /** Aborts the render (request deadline or cancellation). */
  signal?: AbortSignal | undefined;
  /** Navigation budget; never more than the configured browser timeout. */
  timeoutMs?: number | undefined;
  /** How long to wait for a free browser slot. */
  queueTimeoutMs?: number | undefined;
  blockSignalPatterns?: RegExp[] | undefined;
}

export interface BrowserFetcher {
  fetch(url: string, options?: BrowserFetchOptions): Promise<FetchResult>;
  readonly available: boolean;
  dispose(): Promise<void>;
}

export interface DetectionResult {
  sourceType: SourceType;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  adapterKey: string | null;
}

export interface ExtractionSignals {
  requiredFieldsInferred: boolean;
  titleConfidence: "strong" | "weak";
  timesFromStructuredMetadata: boolean;
  recipeLike: boolean;
  detectionConfidence: DetectionResult["confidence"];
  sectionCohesion: "strong" | "medium" | "weak";
  transcriptQuality: "strong" | "weak" | "missing";
  usedBrowserFallback: boolean;
  blockedSourceSignals: number;
}

export interface ExtractionCandidate {
  recipe: Partial<Recipe>;
  strategy: ExtractionStrategy;
  evidence: string[];
  warnings: string[];
  signals: ExtractionSignals;
  provenance: ExtractionProvenance[];
  fieldProvenance: RecipeFieldProvenance;
}

export interface NormalizedExtraction {
  recipe: Recipe;
  warnings: string[];
  confidenceScore: number;
  missingFields: MissingRecipeField[];
  strategy: ExtractionStrategy;
  sourceType: SourceType;
  fetchMode: FetchMode;
  provenance: ExtractionProvenance[];
}

export interface FallbackExtractionInput {
  url: string;
  sourceType: SourceType;
  sourceDocument: SourceDocument;
  candidate: ExtractionCandidate | null;
  detection: DetectionResult;
  fetchMode: FetchMode;
  /**
   * Prompt-ready page summary handed off by the primary attempt. When present,
   * providers use it instead of summarising `sourceDocument.html`.
   */
  sourceSummary?: string | undefined;
  /** Request deadline; providers size their timeouts and attempts to fit it. */
  deadline?: RequestDeadline | undefined;
}

export interface FallbackRecipeExtractor {
  extract(input: FallbackExtractionInput): Promise<ExtractionCandidate | null>;
  /** Reloads runtime-managed settings (the admin model switch) before they are read. */
  refresh?(): Promise<void>;
  readonly available: boolean;
  readonly providerName: "gemini" | "openai" | "none";
}

export interface RecipeTextCleanerOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface RecipeTextCleaner {
  clean(recipe: Recipe, options?: RecipeTextCleanerOptions): Promise<Recipe>;
  readonly available: boolean;
  readonly providerName: "gemini" | "none";
}

export interface SourceFetchOptions {
  deadline?: RequestDeadline | undefined;
}

export interface ExtractorRuntime {
  fetchImplementation: typeof fetch;
  fetchHtmlDocument(url: string, options?: SourceFetchOptions): Promise<FetchResult>;
  fetchYouTubeDocument(
    url: string,
    videoId: string,
    options?: SourceFetchOptions
  ): Promise<YouTubeSourceDocument>;
  fallbackExtractor: FallbackRecipeExtractor;
  recipeTextCleaner?: RecipeTextCleaner;
  /** URL-keyed store of validated success responses. Test runtimes omit it unless they opt in. */
  extractionCache?: ExtractionResultCache;
  /** Short-lived primary-to-fallback document hand-off, keyed by correlation id and URL. */
  fallbackHandoffStore?: FallbackHandoffStore;
  validateSourceUrl: ValidateSourceUrl;
  dispose(): Promise<void>;
}

export type ExtractionFailureReason = ExtractRecipeFailure["reason"];
export type ExtractionRetryReason = ExtractRecipeNeedsRetry["reason"];

export interface RetryDiagnostics {
  confidenceScore: number;
  missingFields: MissingRecipeField[];
}

export interface DeterministicRetryDecision {
  kind: "needs_retry";
  reason: ExtractionRetryReason;
  sourceType: SourceType;
  userMessage: string;
  diagnostics: RetryDiagnostics;
  candidate: ExtractionCandidate | null;
  recovery: {
    retryable: boolean;
    allowFallback: boolean;
    suggestedAction: "retry_primary" | "retry_fallback" | "try_another_url" | "try_again_later";
  };
}

export interface DeterministicFailureDecision {
  kind: "failure";
  reason: ExtractionFailureReason;
  userMessage: string;
  recovery: {
    retryable: boolean;
    allowFallback: boolean;
    suggestedAction: "retry_primary" | "retry_fallback" | "try_another_url" | "try_again_later";
  };
}

export interface DeterministicSuccessDecision {
  kind: "success";
  result: NormalizedExtraction;
}

export type DeterministicDecision =
  | DeterministicSuccessDecision
  | DeterministicRetryDecision
  | DeterministicFailureDecision;

export interface ExtractionLogContext {
  hostname: string;
  sourceType: SourceType;
  detectionConfidence: DetectionResult["confidence"];
  attempt: "primary" | "fallback";
  outcomeStatus:
    | ExtractRecipeSuccess["status"]
    | ExtractRecipeNeedsRetry["status"]
    | ExtractRecipeFailure["status"];
  strategy: ExtractionStrategy | "none";
  fetchMode: FetchMode | "none";
  confidenceScore: number | null;
  missingFieldCount: number;
  fallbackProvider: FallbackRecipeExtractor["providerName"];
  failureReason: ExtractRecipeFailure["reason"] | null;
  statusCode: number | null;
  finalUrl: string | null;
  blockedSignals: string[];
  browserAttempted: boolean;
  /** URL result cache outcome: served from cache, looked up and missed, or not consulted. */
  cacheStatus?: "hit" | "miss" | "bypass";
  /** Whether the Gemini text cleanup ran for a success, and why not when it did not. */
  textCleanup?: "applied" | "not_needed" | "disabled" | "skipped_budget";
  /** Fallback attempts: whether the primary attempt's handed-off document was reused. */
  fallbackHandoff?: "used" | "missing";
  latencyMs: number;
}
