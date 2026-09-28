import { useSyncExternalStore } from "react";

import { readCachedAuthUser } from "./auth-cache";
import { hasClerkSessionHint } from "./clerk-session-hint";

/**
 * Lazy Clerk.
 *
 * `@clerk/clerk-react` (and the clerk-js runtime it downloads from Clerk) is only needed by people
 * who are, or are about to be, signed in with Clerk. Instead of wrapping the whole app in
 * `<ClerkProvider>`, a lazily loaded bridge (`ClerkBridge.tsx`) is mounted as a *sibling* of the
 * app tree when Clerk is needed, so mounting it never remounts the app. The bridge pushes Clerk's
 * state and actions into this tiny store, which `AuthProvider` reads.
 *
 * The bridge mounts when:
 * - Clerk's session cookie says someone may be signed in (`hasClerkSessionHint`),
 * - the last signed-in user came from Clerk (cached), or the page is `/sso-callback`, or
 * - sign-in starts (`requestClerk("sign_in")`, e.g. from `loginWithGoogle`).
 *
 * Without `VITE_CLERK_PUBLISHABLE_KEY` nothing here ever mounts.
 */

export type ClerkBridgeStatus = "idle" | "loading" | "ready" | "failed";

export type ClerkRequestReason =
  | "session_hint"
  | "cached_user"
  | "sso_callback"
  | "sign_in"
  | "sign_in_view";

export interface ClerkBridgeSnapshot {
  /** The bridge should be (or is) mounted. */
  requested: boolean;
  status: ClerkBridgeStatus;
  /** Clerk's `useAuth().isLoaded`. */
  isLoaded: boolean;
  /** Clerk's `useAuth().isSignedIn`. */
  isSignedIn: boolean;
  /** `useSignIn()` is loaded and can start an OAuth redirect. */
  signInReady: boolean;
  /** Bumped when a failed bridge is requested again, so its boundary remounts. */
  attempt: number;
  /** Why the bridge was first requested (null while idle). */
  reason: ClerkRequestReason | null;
}

export interface ClerkRedirectParams {
  strategy: "oauth_google";
  redirectUrl: string;
  redirectUrlComplete: string;
}

/** Clerk actions, registered by the mounted bridge. */
export interface ClerkBridgeControls {
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  authenticateWithRedirect: (params: ClerkRedirectParams) => Promise<void>;
}

export const SSO_CALLBACK_PATH = "/sso-callback";

export const getClerkPublishableKey = (): string =>
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) || "";

export const isClerkConfigured = (): boolean => getClerkPublishableKey() !== "";

const readPathname = (): string => {
  try {
    return window.location.pathname;
  } catch {
    return "/";
  }
};

/** Why Clerk is needed right away on this page load, if at all. */
export const getBootClerkReason = (): ClerkRequestReason | null => {
  if (!isClerkConfigured()) {
    return null;
  }

  if (readPathname() === SSO_CALLBACK_PATH) {
    return "sso_callback";
  }

  if (hasClerkSessionHint()) {
    return "session_hint";
  }

  return readCachedAuthUser()?.source === "clerk" ? "cached_user" : null;
};

const createInitialSnapshot = (): ClerkBridgeSnapshot => {
  const reason = getBootClerkReason();

  return {
    attempt: 0,
    isLoaded: false,
    isSignedIn: false,
    reason,
    requested: reason !== null,
    signInReady: false,
    status: reason !== null ? "loading" : "idle"
  };
};

let snapshot: ClerkBridgeSnapshot | null = null;
let controls: ClerkBridgeControls | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => {
    listener();
  });
};

const update = (patch: Partial<ClerkBridgeSnapshot>) => {
  const current = getClerkBridgeSnapshot();
  const changed = (Object.keys(patch) as Array<keyof ClerkBridgeSnapshot>).some(
    (key) => patch[key] !== current[key]
  );

  if (!changed) {
    return;
  }

  snapshot = { ...current, ...patch };
  emit();
};

/** The current bridge state; the first read decides whether Clerk is needed at boot. */
export const getClerkBridgeSnapshot = (): ClerkBridgeSnapshot => {
  snapshot ??= createInitialSnapshot();
  return snapshot;
};

export const subscribeClerkBridge = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const useClerkBridge = (): ClerkBridgeSnapshot =>
  useSyncExternalStore(subscribeClerkBridge, getClerkBridgeSnapshot, getClerkBridgeSnapshot);

/**
 * Asks for the Clerk bridge to be mounted. A no-op without a publishable key or when it is
 * already mounted; after a failed load it tries again.
 */
export const requestClerk = (reason: ClerkRequestReason): void => {
  if (!isClerkConfigured()) {
    return;
  }

  const current = getClerkBridgeSnapshot();

  if (current.requested && current.status !== "failed") {
    return;
  }

  update({
    attempt: current.status === "failed" ? current.attempt + 1 : current.attempt,
    reason: current.reason ?? reason,
    requested: true,
    status: current.isLoaded ? "ready" : "loading"
  });
};

/** Called by the bridge whenever Clerk's state changes. */
export const publishClerkState = (state: {
  isLoaded: boolean;
  isSignedIn: boolean;
  signInReady: boolean;
}): void => {
  update({
    isLoaded: state.isLoaded,
    isSignedIn: state.isLoaded && state.isSignedIn,
    signInReady: state.signInReady,
    status: state.isLoaded ? "ready" : "loading"
  });
};

/** Called when the bridge chunk (or Clerk itself) cannot be loaded. */
export const markClerkBridgeFailed = (): void => {
  update({ isLoaded: false, isSignedIn: false, signInReady: false, status: "failed" });
};

export const registerClerkControls = (next: ClerkBridgeControls | null): void => {
  controls = next;
};

export const getClerkControls = (): ClerkBridgeControls | null => controls;

export class ClerkUnavailableError extends Error {
  constructor(message = "Google sign-in is temporarily unavailable. Use email sign-in for now.") {
    super(message);
    this.name = "ClerkUnavailableError";
  }
}

/**
 * Mounts the bridge if needed and resolves with Clerk's controls once Clerk has loaded and can
 * start a sign-in. Rejects with {@link ClerkUnavailableError} on failure or after `timeoutMs`.
 */
export const loadClerk = (timeoutMs: number): Promise<ClerkBridgeControls> => {
  if (!isClerkConfigured()) {
    return Promise.reject(new ClerkUnavailableError());
  }

  requestClerk("sign_in");

  return new Promise<ClerkBridgeControls>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(() => {
      finish(() => reject(new ClerkUnavailableError()));
    }, timeoutMs);

    function finish(settle: () => void) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      unsubscribe();
      settle();
    }

    const check = () => {
      const current = getClerkBridgeSnapshot();

      if (current.status === "failed") {
        finish(() => reject(new ClerkUnavailableError()));
        return;
      }

      if (current.isLoaded && current.signInReady && controls) {
        const ready = controls;
        finish(() => resolve(ready));
      }
    };

    unsubscribe = subscribeClerkBridge(check);
    check();
  });
};

/** Why the bridge was requested when someone may already be signed in (not just signing in). */
const SESSION_REASONS: ReadonlySet<ClerkRequestReason> = new Set<ClerkRequestReason>([
  "cached_user",
  "session_hint",
  "sso_callback"
]);

const requestedForSession = (current: ClerkBridgeSnapshot): boolean =>
  current.reason !== null && SESSION_REASONS.has(current.reason);

/**
 * Someone may be signed in with Clerk but Clerk has not loaded yet, so their token cannot be read
 * yet. Requests sent now would go out without credentials.
 */
export const isClerkSessionPending = (
  current: ClerkBridgeSnapshot = getClerkBridgeSnapshot()
): boolean =>
  current.requested &&
  !current.isLoaded &&
  current.status !== "failed" &&
  requestedForSession(current);

/** Whether a Clerk session may exist: Clerk's answer once loaded, the boot hints until then. */
export const mayHaveClerkSession = (
  current: ClerkBridgeSnapshot = getClerkBridgeSnapshot()
): boolean =>
  current.isLoaded
    ? current.isSignedIn
    : isClerkConfigured() && (requestedForSession(current) || hasClerkSessionHint());

const isClerkSettled = (current: ClerkBridgeSnapshot): boolean =>
  !current.requested || current.isLoaded || current.status === "failed";

let settleWait: { attempt: number; promise: Promise<void> } | null = null;

/**
 * Resolves once Clerk has loaded or failed to load, or after `timeoutMs`. Callers share one wait
 * per load attempt, and once that wait has run out later calls resolve at once, so a Clerk script
 * that never arrives delays requests only once. Never rejects.
 */
export const waitForClerkSettled = (timeoutMs: number): Promise<void> => {
  const current = getClerkBridgeSnapshot();

  if (isClerkSettled(current)) {
    return Promise.resolve();
  }

  if (settleWait?.attempt === current.attempt) {
    return settleWait.promise;
  }

  const promise = new Promise<void>((resolve) => {
    const unsubscribe = subscribeClerkBridge(() => {
      if (isClerkSettled(getClerkBridgeSnapshot())) {
        done();
      }
    });
    const timer = setTimeout(done, timeoutMs);

    function done() {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
  settleWait = { attempt: current.attempt, promise };
  return promise;
};

export const resetClerkBridgeForTests = (): void => {
  snapshot = null;
  controls = null;
  settleWait = null;
  listeners.clear();
};
