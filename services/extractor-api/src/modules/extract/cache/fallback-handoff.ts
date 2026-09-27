import { createHash } from "node:crypto";

import { createDefaultCacheStore, type CacheStore } from "./cache-store.js";
import { canonicalizeSourceUrl } from "./canonical-url.js";
import { EXTRACTOR_CACHE_VERSION } from "./extraction-cache.js";

import type { FetchMode } from "../../../../../../packages/api-contracts/src/index.js";
import type {
  DetectionResult,
  ExtractionCandidate,
  HtmlSourceDocument,
  YouTubeSourceDocument
} from "../types.js";

/*
 * When the primary attempt returns needs_retry, the client's explicit "AI
 * help" retry used to fetch the page again (often including a fresh Chromium
 * launch) seconds after the first fetch. The primary attempt now stores what
 * the LLM fallback needs, keyed by the import's correlation id and URL, and the
 * fallback attempt goes straight to the model when it finds it.
 *
 * Only page content derived from the public URL is stored (no user or quota
 * data), and entries expire after 15 minutes.
 */
export const FALLBACK_HANDOFF_TTL_SECONDS = 15 * 60;
const handoffKeyPrefix = "linkdish:extract-handoff:v1";
const handoffEntryVersion = 1;
/* A handed-off entry is a page summary (~15 KB) or a transcript; skip anything unusually large. */
export const maxFallbackHandoffBytes = 256 * 1024;

/** The fetched document without its raw markup (HTML pages are handed off as a prompt summary). */
export type HandoffSourceDocument =
  | (Omit<HtmlSourceDocument, "html"> & { html: "" })
  | (Omit<YouTubeSourceDocument, "pageHtml"> & { pageHtml: null });

export interface FallbackHandoff {
  url: string;
  detection: DetectionResult;
  fetchMode: FetchMode;
  candidate: ExtractionCandidate | null;
  sourceDocument: HandoffSourceDocument;
  /** Prompt-ready page summary for HTML documents. */
  sourceSummary: string | null;
}

export interface FallbackHandoffStore {
  read(correlationId: string, url: string): Promise<FallbackHandoff | null>;
  /** Returns false when the entry was too large to store. */
  write(correlationId: string, url: string, handoff: FallbackHandoff): Promise<boolean>;
}

export const getFallbackHandoffKey = (correlationId: string, url: string): string =>
  `${handoffKeyPrefix}:${EXTRACTOR_CACHE_VERSION}:${createHash("sha256")
    .update(correlationId)
    .update("\n")
    .update(canonicalizeSourceUrl(url))
    .digest("hex")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isHandoffSourceDocument = (value: unknown): value is HandoffSourceDocument =>
  isRecord(value) &&
  ((value.kind === "html" && typeof value.finalUrl === "string") ||
    (value.kind === "youtube" && typeof value.videoId === "string"));

const parseHandoff = (rawValue: string, url: string): FallbackHandoff | null => {
  let value: unknown;

  try {
    value = JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }

  if (
    !isRecord(value) ||
    value.v !== handoffEntryVersion ||
    typeof value.url !== "string" ||
    canonicalizeSourceUrl(value.url) !== canonicalizeSourceUrl(url) ||
    !isRecord(value.detection) ||
    (value.fetchMode !== "http" && value.fetchMode !== "browser") ||
    !isHandoffSourceDocument(value.sourceDocument) ||
    (value.sourceSummary !== null && typeof value.sourceSummary !== "string") ||
    (value.candidate !== null && !isRecord(value.candidate))
  ) {
    return null;
  }

  const sourceType = value.detection.sourceType;

  if (sourceType !== "recipe-webpage" && sourceType !== "article" && sourceType !== "youtube") {
    return null;
  }

  return {
    url: value.url,
    detection: value.detection as unknown as DetectionResult,
    fetchMode: value.fetchMode,
    candidate: value.candidate as ExtractionCandidate | null,
    sourceDocument: value.sourceDocument,
    sourceSummary: value.sourceSummary
  };
};

export const createFallbackHandoffStore = ({
  store = createDefaultCacheStore({ maxMemoryEntries: 200 }),
  ttlSeconds = FALLBACK_HANDOFF_TTL_SECONDS
}: {
  store?: CacheStore;
  ttlSeconds?: number;
} = {}): FallbackHandoffStore => ({
  read: async (correlationId, url) => {
    const rawValue = await store.get(getFallbackHandoffKey(correlationId, url));
    return rawValue ? parseHandoff(rawValue, url) : null;
  },
  write: async (correlationId, url, handoff) => {
    const serialized = JSON.stringify({ v: handoffEntryVersion, ...handoff });

    if (Buffer.byteLength(serialized, "utf8") > maxFallbackHandoffBytes) {
      return false;
    }

    await store.set(getFallbackHandoffKey(correlationId, url), serialized, ttlSeconds);
    return true;
  }
});

export const toHandoffSourceDocument = (
  document: HtmlSourceDocument | YouTubeSourceDocument
): HandoffSourceDocument =>
  document.kind === "html" ? { ...document, html: "" } : { ...document, pageHtml: null };
