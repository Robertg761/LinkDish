import { safeGetItem, safeSetItem } from "../platform/safe-storage";
import { getStableClientId } from "../platform/stable-client-id";

const SESSION_ID_KEY = "linkdish:web:analytics-session-id:v1";
const SESSION_LAST_SEEN_KEY = "linkdish:web:analytics-session-last-seen:v1";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Fallback session used when storage refuses reads/writes (Safari Private
 * Browsing, "block all cookies", Firefox strict mode).
 */
let inMemorySession: { id: string; lastSeen: number } | null = null;

export const createWebAnalyticsId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return "10000000-1000-4000-8000-100000000000".replace(/[018]/gu, (character) =>
    (
      Number(character) ^
      (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(character) / 4)))
    ).toString(16)
  );
};

export const getWebAnalyticsClientId = (): string => getStableClientId();

export const getWebAnalyticsSessionId = (): string => {
  const now = Date.now();
  const storedSessionId = safeGetItem(SESSION_ID_KEY);
  const storedLastSeen = Number(safeGetItem(SESSION_LAST_SEEN_KEY) ?? 0);

  // When storage is blocked both reads come back empty, so fall back to the
  // in-memory session instead of minting a new id on every request.
  const sessionId = storedSessionId ?? inMemorySession?.id ?? null;
  const lastSeen = storedSessionId ? storedLastSeen : (inMemorySession?.lastSeen ?? storedLastSeen);

  let nextSessionId = sessionId;

  if (!nextSessionId || !Number.isFinite(lastSeen) || now - lastSeen > SESSION_TIMEOUT_MS) {
    nextSessionId = createWebAnalyticsId();
    safeSetItem(SESSION_ID_KEY, nextSessionId);
  }

  safeSetItem(SESSION_LAST_SEEN_KEY, String(now));
  inMemorySession = { id: nextSessionId, lastSeen: now };

  return nextSessionId;
};

/** Test seam: drops the in-memory fallback session. */
export const resetInMemorySessionForTests = (): void => {
  inMemorySession = null;
};
