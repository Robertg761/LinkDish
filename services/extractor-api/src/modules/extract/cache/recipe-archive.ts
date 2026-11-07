import { extractRecipeSuccessSchema } from "../../../../../../packages/api-contracts/src/index.js";

import { canonicalizeSourceUrl, hashCanonicalSourceUrl } from "./canonical-url.js";
import {
  EXTRACTOR_CACHE_VERSION,
  evaluateExtractionCacheWrite,
  isLlmDerivedExtraction,
  type CachedExtraction,
  type ExtractionCacheSkipReason,
  type ExtractionCacheWrite
} from "./extraction-cache.js";

import type { DetectionResult } from "../types.js";

/*
 * LinkDish's own database of recipes it has read, keyed by the canonical source URL (the same
 * key the result cache uses). The result cache in Upstash is short-lived and is emptied by every
 * EXTRACTOR_CACHE_VERSION bump; the archive keeps each recipe in Postgres until someone removes
 * it, so a later import of the same link is served from LinkDish's own copy instead of the site.
 *
 * It holds exactly what the result cache may hold (evaluateExtractionCacheWrite): validated,
 * deterministic successes over the confidence bar, never LLM output, never a cross-site
 * redirect. Only the structured recipe is kept (title, ingredients, steps, times, the image's
 * URL, the source link and attribution fields), never the page's HTML or image bytes.
 * People's own edits live in their cookbooks and never touch an archive entry.
 *
 * Freshness: an entry written by the current extractor within RECIPE_ARCHIVE_REFRESH_AFTER_DAYS
 * is served without contacting the site. Otherwise the import reads the site again and a
 * success replaces the entry; if that read fails (the site now blocks LinkDish, the page is gone,
 * DNS fails), the stored copy is served instead and the failed refresh is noted, so the site is
 * not asked again for a day.
 */

export type RecipeArchiveOrigin = "server";

export interface RecipeArchiveRecord {
  urlHash: string;
  canonicalUrl: string;
  sourceHostname: string;
  sourceType: string;
  extractorVersion: string;
  origin: RecipeArchiveOrigin;
  /** The validated success response, without any caller's quota. */
  response: unknown;
  finalUrl: string | null;
  statusCode: number | null;
  detectionConfidence: DetectionResult["confidence"];
  extractedAt: string;
  refreshFailedAt: string | null;
}

/** Persistence for the archive. Postgres in production; an in-memory map in tests. */
export interface RecipeArchiveStore {
  get(urlHash: string): Promise<RecipeArchiveRecord | null>;
  /**
   * Inserts or replaces the entry (a replacement clears refreshFailedAt). Returns false, storing
   * nothing, when the link was removed by an admin.
   */
  put(record: Omit<RecipeArchiveRecord, "refreshFailedAt">): Promise<boolean>;
  markRefreshFailed(urlHash: string, at: string): Promise<void>;
  /**
   * Deletes the entry and records the removal, so the link is never archived again. Returns
   * whether an entry existed.
   */
  remove(urlHash: string, canonicalUrl: string, at: string): Promise<boolean>;
}

export type RecipeArchiveSkipReason = ExtractionCacheSkipReason | "removed";

export interface ArchivedRecipe extends CachedExtraction {
  extractorVersion: string;
  origin: RecipeArchiveOrigin;
  refreshFailedAt: string | null;
}

export interface RecipeArchive {
  /** The stored recipe for this link, or null. A slow or failing store reads as null. */
  read(url: string): Promise<ArchivedRecipe | null>;
  /** True when the entry may be served without asking the site first. */
  isFresh(entry: ArchivedRecipe, now?: Date): boolean;
  /**
   * Stores a shareable success; returns why it was not stored, or null when stored. "removed"
   * means an admin took the link out, and it must not be shared from the result cache either.
   */
  write(entry: ExtractionCacheWrite): Promise<RecipeArchiveSkipReason | null>;
  /** Notes that reading the site again failed, so it is not retried for a while. */
  markRefreshFailed(url: string, now?: Date): Promise<void>;
  /**
   * Removes a link's entry and keeps it out from then on (a takedown request, a bad entry).
   * True when an entry existed.
   */
  remove(url: string, now?: Date): Promise<boolean>;
}

export const recipeArchiveReadTimeoutMs = 1_500;
/* After a failed refresh the stored copy is served without asking the site for this long. */
export const recipeArchiveRefreshBackoffMs = 24 * 60 * 60 * 1_000;

const isConfidence = (value: unknown): value is DetectionResult["confidence"] =>
  value === "high" || value === "medium" || value === "low";

const toArchivedRecipe = (record: RecipeArchiveRecord): ArchivedRecipe | null => {
  /* An entry written under an older response shape that no longer validates is a miss. */
  const response = extractRecipeSuccessSchema.safeParse(record.response);

  if (
    !response.success ||
    isLlmDerivedExtraction(response.data) ||
    !isConfidence(record.detectionConfidence)
  ) {
    return null;
  }

  /* A caller's quota is never part of a shared entry. */
  const shared = { ...response.data };
  delete shared.quota;

  return {
    response: shared,
    finalUrl: record.finalUrl,
    statusCode: record.statusCode,
    detectionConfidence: record.detectionConfidence,
    storedAt: record.extractedAt,
    extractorVersion: record.extractorVersion,
    origin: record.origin,
    refreshFailedAt: record.refreshFailedAt
  };
};

const withTimeout = <Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
};

const hostnameOf = (url: string): string => new URL(url).hostname.toLowerCase();

export const createRecipeArchive = ({
  store,
  refreshAfterMs,
  readTimeoutMs = recipeArchiveReadTimeoutMs
}: {
  store: RecipeArchiveStore;
  refreshAfterMs: number;
  readTimeoutMs?: number;
}): RecipeArchive => ({
  read: async (url) => {
    const pending = store.get(hashCanonicalSourceUrl(url));
    /* A late rejection after the timeout won is still handled. */
    void pending.catch(() => undefined);
    const record = await withTimeout(pending, readTimeoutMs);
    return record ? toArchivedRecipe(record) : null;
  },
  isFresh: (entry, now = new Date()) => {
    const nowMs = now.getTime();
    const refreshFailedMs = entry.refreshFailedAt ? Date.parse(entry.refreshFailedAt) : Number.NaN;

    if (
      Number.isFinite(refreshFailedMs) &&
      nowMs - refreshFailedMs < recipeArchiveRefreshBackoffMs
    ) {
      return true;
    }

    const extractedMs = Date.parse(entry.storedAt);

    return (
      entry.extractorVersion === EXTRACTOR_CACHE_VERSION &&
      Number.isFinite(extractedMs) &&
      nowMs - extractedMs < refreshAfterMs
    );
  },
  write: async (entry) => {
    const decision = evaluateExtractionCacheWrite(entry);

    if ("skipReason" in decision) {
      return decision.skipReason;
    }

    const canonicalUrl = canonicalizeSourceUrl(entry.requestUrl);
    /*
     * The first importer's exact link (other query parameters, a share token) is not kept: hits
     * re-stamp sourceUrl with each caller's own link anyway.
     */
    const response = {
      ...decision.response,
      recipe: { ...decision.response.recipe, sourceUrl: canonicalUrl }
    };
    const stored = await store.put({
      urlHash: hashCanonicalSourceUrl(entry.requestUrl),
      canonicalUrl,
      sourceHostname: hostnameOf(entry.requestUrl),
      sourceType: decision.response.extraction.sourceType,
      extractorVersion: EXTRACTOR_CACHE_VERSION,
      origin: "server",
      response,
      finalUrl: entry.finalUrl,
      statusCode: entry.statusCode,
      detectionConfidence: entry.detectionConfidence,
      extractedAt: new Date().toISOString()
    });

    return stored ? null : "removed";
  },
  markRefreshFailed: (url, now = new Date()) =>
    store.markRefreshFailed(hashCanonicalSourceUrl(url), now.toISOString()),
  remove: (url, now = new Date()) =>
    store.remove(hashCanonicalSourceUrl(url), canonicalizeSourceUrl(url), now.toISOString())
});

/* For tests and local development without a database. */
export const createMemoryRecipeArchiveStore = (): RecipeArchiveStore & {
  records: Map<string, RecipeArchiveRecord>;
  removals: Set<string>;
} => {
  const records = new Map<string, RecipeArchiveRecord>();
  const removals = new Set<string>();

  return {
    records,
    removals,
    get: (urlHash) =>
      Promise.resolve(removals.has(urlHash) ? null : (records.get(urlHash) ?? null)),
    put: (record) => {
      if (removals.has(record.urlHash)) {
        return Promise.resolve(false);
      }

      records.set(record.urlHash, { ...record, refreshFailedAt: null });
      return Promise.resolve(true);
    },
    markRefreshFailed: (urlHash, at) => {
      const record = records.get(urlHash);

      if (record) {
        records.set(urlHash, { ...record, refreshFailedAt: at });
      }

      return Promise.resolve();
    },
    remove: (urlHash) => {
      removals.add(urlHash);
      return Promise.resolve(records.delete(urlHash));
    }
  };
};
