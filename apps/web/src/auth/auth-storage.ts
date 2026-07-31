const SESSION_TOKEN_KEY = "linkdish:web:session-token:v1";

export function getLegacySessionToken(): string | null {
  if (typeof window === "undefined" || typeof sessionStorage === "undefined") {
    return null;
  }

  const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);

  if (sessionToken) {
    return sessionToken;
  }

  if (typeof localStorage === "undefined") {
    return null;
  }

  const persistentToken = localStorage.getItem(SESSION_TOKEN_KEY);

  if (persistentToken) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, persistentToken);
    localStorage.removeItem(SESSION_TOKEN_KEY);
  }

  return persistentToken;
}

export function setLegacySessionToken(token: string): void {
  if (typeof window === "undefined" || typeof sessionStorage === "undefined") {
    return;
  }

  sessionStorage.setItem(SESSION_TOKEN_KEY, token);

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  }
}

export function removeLegacySessionToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  }

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  }
}
