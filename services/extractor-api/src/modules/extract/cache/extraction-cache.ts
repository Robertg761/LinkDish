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
 * URL-keyed cache of validated extraction successes. Popular recipes are
 * imported by many people, and each import used to repeat DNS, the fetch, a
 * possible Playwright render, the parse and the LLM calls. A hit skips all of
 * that; rate limiting, billing authorization and usage commits still run in
 * the request pipeline exactly as for a fresh extraction.
 *
 * Bump EXTRACTOR_CACHE_VERSION whenever extraction output changes (parsers,
 * normalisation, scoring, prompts) so stale results stop being served.
 */
export const EXTRACTOR_CACHE_VERSION = "2026-09-27.1";

const cacheKeyPrefix = "linkdish:extract-cache:v1";
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
  | "invalid_payload"
  | "cross_site_redirect";

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
 * Only validated successes at or above the success confidence bar are shared:
 * never needs_retry, failures, quota errors or image scans, and never a page
 * that redirected to a different site.
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

  if (entry.finalUrl && !isSameSiteFetch(entry.requestUrl, entry.finalUrl)) {
    return { skipReason: "cross_site_redirect" };
  }

  const parsed = extractRecipeSuccessSchema.safeParse(entry.response);

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

  const response = extractRecipeSuccessSchema.safeParse(value.response);
  const detectionConfidence = value.detectionConfidence;

  if (
    !response.success ||
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
