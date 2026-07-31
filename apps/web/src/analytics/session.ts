import { getStableClientId } from "../platform/stable-client-id";

const SESSION_ID_KEY = "linkdish:web:analytics-session-id:v1";
const SESSION_LAST_SEEN_KEY = "linkdish:web:analytics-session-last-seen:v1";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

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
  const lastSeen = Number(localStorage.getItem(SESSION_LAST_SEEN_KEY) ?? 0);
  let sessionId = localStorage.getItem(SESSION_ID_KEY);

  if (!sessionId || !Number.isFinite(lastSeen) || now - lastSeen > SESSION_TIMEOUT_MS) {
    sessionId = createWebAnalyticsId();
    localStorage.setItem(SESSION_ID_KEY, sessionId);
  }

  localStorage.setItem(SESSION_LAST_SEEN_KEY, String(now));
  return sessionId;
};
