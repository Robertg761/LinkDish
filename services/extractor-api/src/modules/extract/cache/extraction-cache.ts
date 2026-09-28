import { createHash } from "node:crypto";

import {
  extractRecipeSuccessSchema,
  type ExtractRecipeResponse,
  type ExtractRecipeSuccess
} from "../../../../../../packages/api-contracts/src/index.js";
import { isThresholdSourceType, successConfidenceThresholds } from "../confidence/thresholds.js";

import { createDefaultCacheStore, type CacheStore } from "./cache-store.js";
import { canonicalizeSourceUrl, isSameSiteFetch } from "./canonical-url.js";

import type { DetectionResult } from "../types.js";

/*
 * URL-keyed cache of validated deterministic extraction successes. Popular
 * recipes are imported by many people, and each import used to repeat DNS, the
 * fetch, a possible Playwright render, the parse and the text-cleanup LLM call.
 * A hit skips all of that; rate limiting, billing authorization and usage
 * commits still run in the request pipeline exactly as for a fresh extraction.
 *
 * Bump EXTRACTOR_CACHE_VERSION whenever extraction output changes (parsers,
 * normalisation, scoring, prompts) so stale results stop being served.
 *
 * 2026-09-28.1: LLM fallback output is no longer shared; entries written under
 * the previous version may hold it.
 */
export const EXTRACTOR_CACHE_VERSION = "2026-09-28.1";

const cacheKeyPrefix = "linkdish:extract-cache:v1";

/*
 * `quota` on a success response is the requesting caller's own allowance. It is attached after
 * extraction and must never be stored in (or served from) the shared cache.
 */
const withoutCallerQuota = (response: unknown): unknown => {
  if (!response || typeof response !== "object" || !("quota" in response)) {
    return response;
  }

  const shared: Record<string, unknown> = { ...(response as Record<string, unknown>) };
  delete shared.quota;
  return shared;
};
const cacheEntryVersion = 1;

export interface CachedExtraction {
  response: ExtractRecipeSuccess;
  /** Where the page was finally fetched from when the entry was stored. */
  finalUrl: string | null;
  statusCode: number | null;
  detectionConfidence: DetectionResult["confidence"];
  storedAt: string;
}

export interface ExtractionCacheWrite {
  response: ExtractRecipeResponse;
  /** The URL the request asked for; the entry is stored under its canonical key. */
  requestUrl: string;
  finalUrl: string | null;
  statusCode: number | null;
  detectionConfidence: DetectionResult["confidence"];
}

export type ExtractionCacheSkipReason =
  | "not_success"
  | "unsupported_source_type"
  | "below_confidence_threshold"
  | "llm_derived"
  | "invalid_payload"
  | "cross_site_redirect";

/*
 * LLM fallback output is never shared. The model reads the page's visible text, which can
 * include comments and other text anyone can post, so a caller could steer one extraction and
 * have it served to every later importer of that URL. Only deterministic extractions of a page
 * the server fetched itself are cached (a primary attempt's optional text cleanup only tidies
 * that deterministic recipe and keeps its strategy and provenance).
 */
const isLlmDerived = (response: ExtractRecipeSuccess): boolean =>
  response.extraction.strategy === "llm-fallback" || response.extraction.provenance.includes("llm");

export interface ExtractionResultCache {
  read(url: string): Promise<CachedExtraction | null>;
  /** Stores a cacheable success; returns why an entry was not stored, or null when stored. */
  write(entry: ExtractionCacheWrite): Promise<ExtractionCacheSkipReason | null>;
}

export const getExtractionCacheKey = (url: string): string =>
  `${cacheKeyPrefix}:${EXTRACTOR_CACHE_VERSION}:${createHash("sha256")
    .update(canonicalizeSourceUrl(url))
    .digest("hex")}`;

/**
 * Only validated deterministic successes at or above the success confidence bar
 * are shared: never needs_retry, failures, quota errors, image scans or LLM
 * output, and never a page that redirected to a different site.
 */
export const evaluateExtractionCacheWrite = (
  entry: ExtractionCacheWrite
): { skipReason: ExtractionCacheSkipReason } | { response: ExtractRecipeSuccess } => {
  if (entry.response.status !== "success") {
    return { skipReason: "not_success" };
  }

  const sourceType = entry.response.extraction.sourceType;

  if (!isThresholdSourceType(sourceType)) {
    return { skipReason: "unsupported_source_type" };
  }

  if (entry.response.extraction.confidenceScore < successConfidenceThresholds[sourceType]) {
    return { skipReason: "below_confidence_threshold" };
  }

  if (isLlmDerived(entry.response)) {
    return { skipReason: "llm_derived" };
  }

  if (entry.finalUrl && !isSameSiteFetch(entry.requestUrl, entry.finalUrl)) {
    return { skipReason: "cross_site_redirect" };
  }

  const parsed = extractRecipeSuccessSchema.safeParse(withoutCallerQuota(entry.response));

  return parsed.success ? { response: parsed.data } : { skipReason: "invalid_payload" };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseCachedEntry = (rawValue: string): CachedExtraction | null => {
  let value: unknown;

  try {
    value = JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }

  if (!isRecord(value) || value.v !== cacheEntryVersion) {
    return null;
  }

  const response = extractRecipeSuccessSchema.safeParse(withoutCallerQuota(value.response));
  const detectionConfidence = value.detectionConfidence;

  if (
    !response.success ||
    isLlmDerived(response.data) ||
    (detectionConfidence !== "high" &&
      detectionConfidence !== "medium" &&
      detectionConfidence !== "low")
  ) {
    return null;
  }

  return {
    response: response.data,
    finalUrl: typeof value.finalUrl === "string" ? value.finalUrl : null,
    statusCode: typeof value.statusCode === "number" ? value.statusCode : null,
    detectionConfidence,
    storedAt: typeof value.storedAt === "string" ? value.storedAt : new Date(0).toISOString()
  };
};

export const createExtractionResultCache = ({
  ttlSeconds,
  store = createDefaultCacheStore({ maxMemoryEntries: 500 })
}: {
  ttlSeconds: number;
  store?: CacheStore;
}): ExtractionResultCache => ({
  read: async (url) => {
    const rawValue = await store.get(getExtractionCacheKey(url));
    return rawValue ? parseCachedEntry(rawValue) : null;
  },
  write: async (entry) => {
    const decision = evaluateExtractionCacheWrite(entry);

    if ("skipReason" in decision) {
      return decision.skipReason;
    }

    await store.set(
      getExtractionCacheKey(entry.requestUrl),
      JSON.stringify({
        v: cacheEntryVersion,
        storedAt: new Date().toISOString(),
        finalUrl: entry.finalUrl,
        statusCode: entry.statusCode,
        detectionConfidence: entry.detectionConfidence,
        response: decision.response
      }),
      ttlSeconds
    );

    return null;
  }
});
