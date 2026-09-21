import { safeGetItem, safeRemoveItem, safeSetItem } from "../platform/safe-storage";

const SESSION_TOKEN_KEY = "linkdish:web:session-token:v1";

export function getLegacySessionToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const sessionToken = safeGetItem(SESSION_TOKEN_KEY, "session");

  if (sessionToken) {
    return sessionToken;
  }

  const persistentToken = safeGetItem(SESSION_TOKEN_KEY, "local");

  // Only drop the persistent copy once it has actually been moved, so a
  // blocked storage area does not silently sign the user out.
  if (persistentToken && safeSetItem(SESSION_TOKEN_KEY, persistentToken, "session")) {
    safeRemoveItem(SESSION_TOKEN_KEY, "local");
  }

  return persistentToken;
}

export function setLegacySessionToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }

  safeSetItem(SESSION_TOKEN_KEY, token, "session");
  safeRemoveItem(SESSION_TOKEN_KEY, "local");
}

export function removeLegacySessionToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  safeRemoveItem(SESSION_TOKEN_KEY, "session");
  safeRemoveItem(SESSION_TOKEN_KEY, "local");
}
