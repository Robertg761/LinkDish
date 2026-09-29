import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { trackWebEvent } from "../analytics/client";
import { apiClient, registerAuthTokenProvider } from "../api/client";
import { isExtractorApiError } from "../api/errors";
import { asAccount } from "../api/request-binding";

import { getAccountScope, publishCurrentAccount } from "./account-scope";
import {
  clearCachedAuthUser,
  clearClerkSignOutPending,
  isClerkSignOutPending,
  markClerkSignOutPending,
  readCachedAuthConfig,
  readCachedAuthUser,
  readClerkSignOutPending,
  writeCachedAuthConfig,
  writeCachedAuthUser,
  type CachedAuthUserSource
} from "./auth-cache";
import {
  getLegacySessionToken,
  setLegacySessionToken,
  removeLegacySessionToken
} from "./auth-storage";
import {
  getClerkBridgeSnapshot,
  getClerkControls,
  isClerkConfigured,
  isClerkSessionPending,
  loadClerk,
  mayHaveClerkSession,
  requestClerk,
  useClerkBridge,
  waitForClerkSettled
} from "./clerk-bridge";
import { hasClerkSessionHint } from "./clerk-session-hint";

import type { AccountUser, AuthConfigResponse, AuthMode } from "@linkdish/api-contracts";

/** Auth config is tiny; a slow answer should not hold the app hostage. */
export const AUTH_CONFIG_TIMEOUT_MS = 4_000;
const AUTH_CONFIG_RETRY_DELAYS_MS = [250, 750];
/** How long to wait for Clerk before treating a visitor without a cached session as signed out. */
export const CLERK_LOAD_TIMEOUT_MS = 8_000;

interface AuthContextType {
  user: AccountUser | null;
  isAuthenticated: boolean;
  authMode: AuthMode | null;
  emailCodeEnabled: boolean;
  clerkEnabled: boolean;
  clerkReady: boolean;
  hasClerkPublishableKey: boolean;
  loading: boolean;
  /**
   * API requests now carry the right credentials: auth has settled and, when a Clerk session may
   * exist, Clerk has loaded (or the wait for it ran out). A cached Clerk user is shown (and
   * `loading` is false) before this, so anything that must not run anonymous waits for it.
   */
  credentialsReady: boolean;
  /**
   * Identifies the credentials API requests carry; null until they are ready. It changes when they
   * do (e.g. Clerk finishes signing in late), so account-scoped fetches key on it.
   */
  credentialsKey: string | null;
  // Legacy email-code actions
  requestLoginCode: (email: string) => Promise<void>;
  verifyLoginCode: (email: string, code: string) => Promise<void>;
  // Clerk actions
  loginWithGoogle: (redirectUrlComplete?: string) => Promise<void>;
  /** Starts loading Clerk ahead of a likely Google sign-in (e.g. the sign-in screen is shown). */
  prepareGoogleSignIn: () => void;
  // Global actions
  logout: () => Promise<void>;
  deleteAccount: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException("The auth config request timed out.", "TimeoutError"));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

async function getAuthConfigWithRetry(retry: boolean): Promise<AuthConfigResponse> {
  let lastError: unknown;
  const delays = retry ? AUTH_CONFIG_RETRY_DELAYS_MS : [];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await withTimeout(apiClient.getAuthConfig(), AUTH_CONFIG_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      const delay = delays[attempt];

      if (delay == null) {
        break;
      }

      await wait(delay);
    }
  }

  throw lastError;
}

type AuthTransport = "clerk" | "legacy" | "unknown";

/** Which credential the API should see, given the server config and whether Clerk is available. */
const getAuthTransport = (
  config: AuthConfigResponse | null,
  clerkAvailable: boolean
): AuthTransport => {
  if (!config) {
    return "unknown";
  }

  return (config.authMode === "clerk_beta" || config.authMode === "clerk_primary") &&
    config.clerkEnabled &&
    clerkAvailable
    ? "clerk"
    : "legacy";
};

type SessionResult =
  | { kind: "user"; user: AccountUser }
  | { kind: "signed_out" }
  | { error: unknown; kind: "unknown" };

/** Only an explicit answer (or a 401) means signed out; network trouble is "unknown". */
async function fetchSession(): Promise<SessionResult> {
  try {
    const session = await apiClient.getSession();
    return session.authenticated ? { kind: "user", user: session.user } : { kind: "signed_out" };
  } catch (error) {
    if (isExtractorApiError(error) && error.statusCode === 401) {
      return { kind: "signed_out" };
    }

    return { error, kind: "unknown" };
  }
}

const isBrowserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

let clerkSignOutInFlight: Promise<void> | null = null;

/**
 * Ends a Clerk session the user already signed out of here (see `markClerkSignOutPending`). Does
 * nothing until Clerk has loaded; safe to call repeatedly. The intent is kept if Clerk refuses, so
 * the next load tries again. A sign-out made for another session than Clerk's active one is
 * dropped instead: Clerk switched to that account since, and it stays signed in.
 */
const finishPendingClerkSignOut = (): Promise<void> => {
  const snapshot = getClerkBridgeSnapshot();
  const controls = getClerkControls();

  if (!snapshot.isLoaded || !controls) {
    return Promise.resolve();
  }

  if (!snapshot.isSignedIn || !isClerkSignOutPending(snapshot.sessionId)) {
    // No session left to end, or the sign-out was for one Clerk has switched away from.
    clearClerkSignOutPending();
    return Promise.resolve();
  }

  // Only that session ends, even if Clerk switches to another one before this runs.
  const sessionId = readClerkSignOutPending()?.clerkSessionId ?? snapshot.sessionId ?? undefined;

  clerkSignOutInFlight ??= controls
    .signOut(sessionId)
    .then(clearClerkSignOutPending, (error: unknown) => {
      console.warn("Clerk sign-out failed:", error);
    })
    .finally(() => {
      clerkSignOutInFlight = null;
    });

  return clerkSignOutInFlight;
};

interface InitialAuthState {
  /** The Clerk session a cached Clerk user was confirmed for (null: none known). */
  clerkSessionId: string | null;
  config: AuthConfigResponse | null;
  loading: boolean;
  user: AccountUser | null;
  userSource: CachedAuthUserSource | null;
}

const readInitialAuthState = (clerkAvailable: boolean): InitialAuthState => {
  const config = readCachedAuthConfig()?.config ?? null;
  const cachedUser = readCachedAuthUser();
  const hasLegacyToken = Boolean(getLegacySessionToken());
  // A cached legacy user without its token is stale; a Clerk user is confirmed once Clerk loads
  // (the Clerk bridge mounts at boot for a cached Clerk user, see clerk-bridge.ts).
  const usable =
    cachedUser && (cachedUser.source === "clerk" ? clerkAvailable : hasLegacyToken)
      ? cachedUser
      : null;

  if (cachedUser && !usable) {
    clearCachedAuthUser();
  }

  const knownAnonymous =
    !usable && config !== null && getAuthTransport(config, clerkAvailable) === "legacy"
      ? !hasLegacyToken
      : false;

  return {
    clerkSessionId: usable?.source === "clerk" ? (usable.clerkSessionId ?? null) : null,
    config,
    loading: !usable && !knownAnonymous,
    user: usable?.user ?? null,
    userSource: usable?.source ?? null
  };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const clerk = useClerkBridge();
  // Clerk is available whenever the build has a key; the bridge itself mounts on demand.
  const hasClerkPublishableKey = isClerkConfigured();
  const clerkAvailable = hasClerkPublishableKey;
  const clerkMounted = clerkAvailable && clerk.requested;

  const [initial] = useState(() => readInitialAuthState(clerkAvailable));
  const [config, setConfig] = useState<AuthConfigResponse | null>(initial.config);
  const [configSettled, setConfigSettled] = useState(initial.config !== null);
  const [user, setUserState] = useState<AccountUser | null>(initial.user);
  const [loading, setLoading] = useState(initial.loading);
  const [clerkWaitExpired, setClerkWaitExpired] = useState(false);

  const clerkLoaded = clerkMounted && clerk.isLoaded;
  const clerkSignedIn = clerkLoaded && clerk.isSignedIn;
  const clerkSessionId = clerkSignedIn ? clerk.sessionId : null;
  const clerkFailed = clerk.status === "failed" || (clerkWaitExpired && !clerkLoaded);
  // "Google sign-in can start": Clerk has loaded, or can be loaded on demand and has not failed.
  const clerkReady = clerkAvailable && !clerkFailed && (clerkLoaded ? clerk.signInReady : true);
  const transport = getAuthTransport(config, clerkAvailable);
  // Someone may be signed in with Clerk but its token is not readable yet (until the wait runs out).
  const clerkCredentialsPending =
    transport !== "legacy" && !clerkWaitExpired && isClerkSessionPending(clerk);
  const credentialsReady = !loading && !clerkCredentialsPending;
  const credentialsKey = credentialsReady
    ? `${transport !== "legacy" && clerkSignedIn ? "clerk" : "session"}:${user?.id ?? ""}`
    : null;

  // Latest values for stable callbacks and the token bridge.
  const transportRef = useRef(transport);
  const configRef = useRef(config);
  const userRef = useRef(user);
  const resolveRunRef = useRef(0);
  /**
   * The Clerk session the signed-in user was last resolved for (null: none yet). A cached user
   * starts with the session it was confirmed for, so it keeps showing only while Clerk is on it.
   */
  const resolvedClerkSessionRef = useRef<string | null>(initial.clerkSessionId);
  /** The same, as state: published with the account, in the same render as the user. */
  const [resolvedClerkSession, setResolvedClerkSession] = useState<string | null>(
    initial.clerkSessionId
  );
  transportRef.current = transport;
  configRef.current = config;
  userRef.current = user;

  const setUser = useCallback(
    (next: AccountUser | null, source?: CachedAuthUserSource, clerkSessionId?: string | null) => {
      userRef.current = next;
      setUserState(next);

      if (next && source) {
        writeCachedAuthUser(next, source, clerkSessionId);
      } else if (!next) {
        clearCachedAuthUser();
      }
    },
    []
  );

  /** A user the API confirmed for Clerk session `clerkSessionId`. */
  const setClerkUser = useCallback(
    (next: AccountUser, clerkSessionId: string | null) => {
      resolvedClerkSessionRef.current = clerkSessionId;
      setResolvedClerkSession(clerkSessionId);
      setUser(next, "clerk", clerkSessionId);
    },
    [setUser]
  );

  /** Token bridge for every API request (registered once, reads the latest auth state). */
  const getSessionToken = useCallback(async (): Promise<string | null> => {
    // Clerk's session is unknown until it loads: any sign-out still on its way counts until then.
    const signingOut = isClerkSignOutPending(getClerkBridgeSnapshot().sessionId);

    if (transportRef.current !== "legacy" && !signingOut && isClerkSessionPending()) {
      // A Clerk session may exist and Clerk is still loading: wait for its token instead of
      // sending the request without one (the API would treat it as anonymous). The wait is shared
      // and bounded by CLERK_LOAD_TIMEOUT_MS, like the auth state's own wait below.
      await waitForClerkSettled(CLERK_LOAD_TIMEOUT_MS);
    }

    const controls = getClerkControls();

    if (
      transportRef.current !== "legacy" &&
      !signingOut &&
      controls &&
      getClerkBridgeSnapshot().isSignedIn
    ) {
      // Clerk beta keeps legacy email-code sessions valid only until Clerk signs in.
      removeLegacySessionToken();

      try {
        return await controls.getToken();
      } catch {
        return null;
      }
    }

    return getLegacySessionToken();
  }, []);

  useEffect(() => {
    registerAuthTokenProvider(getSessionToken);
  }, [getSessionToken]);

  const applySession = useCallback(
    (result: SessionResult, source: CachedAuthUserSource, clerkSessionId: string | null = null) => {
      if (result.kind === "user") {
        if (source === "clerk") {
          setClerkUser(result.user, clerkSessionId);
        } else {
          setUser(result.user, source);
        }
      } else if (result.kind === "signed_out") {
        setUser(null);
      } else {
        // Offline or the API is unreachable: keep whoever we last knew about.
        console.warn("Failed to fetch session:", result.error);
      }
    },
    [setClerkUser, setUser]
  );

  // Load (or revalidate) the auth config once. A cached config renders instantly.
  useEffect(() => {
    let cancelled = false;
    const hadCachedConfig = configRef.current !== null;

    void getAuthConfigWithRetry(!hadCachedConfig)
      .then((fresh) => {
        if (cancelled) {
          return;
        }

        writeCachedAuthConfig(fresh);
        setConfig((current) =>
          current &&
          current.authMode === fresh.authMode &&
          current.clerkEnabled === fresh.clerkEnabled &&
          current.emailCodeEnabled === fresh.emailCodeEnabled
            ? current
            : fresh
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn("Auth initialization failed:", err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setConfigSettled(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Give up waiting for Clerk after a while (blocked script, flaky network) so pages that wait
  // on `loading` are not stuck; a cached user is never demoted by this. It is the same wait the
  // token bridge shares, so requests stop waiting at the same moment.
  useEffect(() => {
    if (!clerkMounted || clerkLoaded || clerkWaitExpired) {
      return;
    }

    let cancelled = false;
    const expire = () => {
      if (!cancelled && !getClerkBridgeSnapshot().isLoaded) {
        setClerkWaitExpired(true);
      }
    };

    if (isBrowserOffline() || clerk.status === "failed") {
      const timer = setTimeout(expire, 0);

      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    void waitForClerkSettled(CLERK_LOAD_TIMEOUT_MS).then(expire);

    return () => {
      cancelled = true;
    };
  }, [clerk.status, clerkLoaded, clerkMounted, clerkWaitExpired]);

  // Clerk loaded after all (e.g. a later sign-in attempt): stop treating it as unavailable.
  useEffect(() => {
    if (clerkLoaded) {
      setClerkWaitExpired(false);
    }
  }, [clerkLoaded]);

  // Resolve who is signed in whenever the config or Clerk's state changes.
  useEffect(() => {
    if (!configSettled) {
      return;
    }

    const run = ++resolveRunRef.current;
    const isCurrent = () => run === resolveRunRef.current;
    const finish = () => {
      if (isCurrent()) {
        setLoading(false);
      }
    };

    const resolveWith = async (source: CachedAuthUserSource) => {
      const result = await fetchSession();

      if (isCurrent()) {
        applySession(result, source, clerkSessionId);
      }

      finish();
    };

    if (transport === "clerk" || (transport === "unknown" && clerkAvailable)) {
      if (!clerkLoaded) {
        if (userRef.current) {
          // Optimistic cached user; revalidate once Clerk is ready.
          finish();
          return;
        }

        if (clerkMounted && !clerkWaitExpired && hasClerkSessionHint()) {
          // Someone may be signed in and Clerk is still loading: stay in `loading` rather than
          // flashing signed-out UI. (Without Clerk's session cookie there is nobody to wait for.)
          setLoading(true);
          return;
        }

        if (getLegacySessionToken()) {
          void resolveWith("legacy");
        } else {
          finish();
        }

        return;
      }

      if (clerkSignedIn && isClerkSignOutPending(clerkSessionId)) {
        // Signed out here before Clerk had loaded: finish that sign-out instead of signing back in.
        void finishPendingClerkSignOut();

        if (getLegacySessionToken()) {
          void resolveWith("legacy");
        } else {
          setUser(null);
          finish();
        }

        return;
      }

      if (clerkSignedIn) {
        // A sign-out still on its way was for a session Clerk has switched away from: that
        // account's sign-out doesn't carry over to this one.
        clearClerkSignOutPending();
        removeLegacySessionToken();

        // Clerk is on a session the shown user wasn't confirmed for: switched straight to another
        // account's, or (a cold boot) settled on one the cached user wasn't cached for. Requests
        // already carry its token, so that user goes at once instead of being shown, and acted
        // for, until the API says whose session it is.
        if (userRef.current && resolvedClerkSessionRef.current !== clerkSessionId) {
          setUser(null);
        }

        if (!userRef.current) {
          setLoading(true);
        }

        void resolveWith("clerk");
        return;
      }

      // Clerk has no session, so no sign-out is left to finish.
      clearClerkSignOutPending();

      if (getLegacySessionToken()) {
        void resolveWith("legacy");
        return;
      }

      setUser(null);
      finish();
      return;
    }

    if (getLegacySessionToken()) {
      void resolveWith("legacy");
      return;
    }

    setUser(null);
    finish();
  }, [
    applySession,
    clerkAvailable,
    clerkLoaded,
    clerkMounted,
    clerkSessionId,
    clerkSignedIn,
    clerkWaitExpired,
    configSettled,
    setUser,
    transport
  ]);

  const refreshUser = useCallback(async () => {
    const clerkNow = getClerkBridgeSnapshot();
    const source: CachedAuthUserSource =
      transportRef.current !== "legacy" && clerkNow.isSignedIn ? "clerk" : "legacy";
    const run = resolveRunRef.current;
    const result = await fetchSession();

    // Clerk switched sessions (or signed in or out) while it was out: the answer may be the last
    // account's, and the new session's own resolution decides who is signed in.
    if (
      run !== resolveRunRef.current ||
      getClerkBridgeSnapshot().sessionId !== clerkNow.sessionId
    ) {
      return;
    }

    applySession(result, source, clerkNow.sessionId);
  }, [applySession]);

  const requestLoginCode = useCallback(async (email: string) => {
    trackWebEvent({
      eventName: "web_sign_in_started",
      routeOrScreen: "/account",
      properties: {
        auth_mode: "email_code"
      }
    });
    await apiClient.requestLoginCode({ email });
  }, []);

  const verifyLoginCode = useCallback(
    async (email: string, code: string) => {
      const res = await apiClient.verifyLoginCode({ email, code });
      if (res.status === "authenticated") {
        setLegacySessionToken(res.sessionToken);
        setUser(res.user, "legacy");
        trackWebEvent({
          eventName: "web_sign_in_completed",
          routeOrScreen: "/account",
          properties: {
            auth_mode: "email_code"
          }
        });
      }
    },
    [setUser]
  );

  const loginWithGoogle = useCallback(
    async (redirectUrlComplete = "/") => {
      if (!configRef.current?.clerkEnabled) {
        throw new Error("Google sign-in is not enabled by the LinkDish API.");
      }

      if (!hasClerkPublishableKey) {
        throw new Error("Google sign-in is not configured for this web app build.");
      }

      // Signing in again replaces an earlier sign-out that had not reached Clerk yet.
      clearClerkSignOutPending();
      // Sign-in starting is one of the moments the lazy Clerk bridge mounts.
      const controls = await loadClerk(CLERK_LOAD_TIMEOUT_MS);

      // If Clerk already has an active session (e.g. from a previous sign-in
      // attempt where the backend was unreachable), try refreshing the backend
      // session first.
      if (getClerkBridgeSnapshot().isSignedIn) {
        removeLegacySessionToken();
        const result = await fetchSession();

        if (result.kind === "user") {
          setClerkUser(result.user, getClerkBridgeSnapshot().sessionId);
          return;
        }

        // Clerk session exists but backend can't authenticate it (expired JWT,
        // mismatched keys, etc.). Sign out of Clerk and start fresh.
        await controls.signOut();
      }

      if (!getClerkBridgeSnapshot().signInReady) {
        throw new Error("Clerk authentication is not initialized or configured.");
      }
      trackWebEvent({
        eventName: "web_sign_in_started",
        routeOrScreen: "/account",
        properties: {
          auth_mode: "clerk_google"
        }
      });
      await controls.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: window.location.origin + "/sso-callback",
        redirectUrlComplete
      });
    },
    [hasClerkPublishableKey, setUser]
  );

  const prepareGoogleSignIn = useCallback(() => {
    if (configRef.current?.clerkEnabled) {
      requestClerk("sign_in_view");
    }
  }, []);

  const logout = useCallback(async () => {
    // Clerk may hold a session before it has loaded (a cached Clerk user, its cookie). Keep the
    // sign-out on record until Clerk confirms it, so Clerk loading later (on this visit or the
    // next) cannot sign the user back in; requests stop carrying the Clerk token right away.
    const endClerkSession = mayHaveClerkSession();
    // The Clerk session being signed out of. A session Clerk switches to meanwhile is another
    // account's and stays signed in. Before Clerk has loaded its session isn't known, so the
    // sign-out ends whichever session it loads with.
    const clerkNow = getClerkBridgeSnapshot();
    const signingOutOf = clerkNow.isLoaded ? clerkNow.sessionId : null;

    if (endClerkSession) {
      markClerkSignOutPending(signingOutOf);
    }

    try {
      await apiClient.logout();
    } catch {
      // Ignore network errors on logout
    }

    // Clear legacy token
    removeLegacySessionToken();

    const clerkAfter = getClerkBridgeSnapshot();
    const switchedAccount =
      endClerkSession &&
      signingOutOf !== null &&
      clerkAfter.isLoaded &&
      clerkAfter.isSignedIn &&
      clerkAfter.sessionId !== signingOutOf;

    if (!switchedAccount) {
      setUser(null);
    }

    if (endClerkSession) {
      requestClerk("session_hint");
      await waitForClerkSettled(CLERK_LOAD_TIMEOUT_MS);
      await finishPendingClerkSignOut();
    }

    trackWebEvent({
      eventName: "web_sign_out_completed",
      routeOrScreen: "/account",
      properties: {}
    });
  }, [setUser]);

  const deleteAccount = useCallback(
    async (email: string) => {
      const deleting = userRef.current?.id;
      // Sent only as the account being deleted, never as one Clerk switches to meanwhile.
      await asAccount(deleting ?? null, () => apiClient.deleteAccount({ confirmEmail: email }));

      // Another account signed in (or out) while the deletion was on its way: signing out now
      // would sign out that account, not the deleted one.
      if (userRef.current?.id !== deleting) {
        return;
      }

      await logout();
    },
    [logout]
  );

  // Work that outlives its component (a toast's action) checks the account through this, and an
  // account-bound request the Clerk session the account was confirmed under.
  const accountScope = getAccountScope(!!user, user);
  const confirmedClerkSession = user ? resolvedClerkSession : null;
  useLayoutEffect(() => {
    publishCurrentAccount(accountScope, confirmedClerkSession);
  }, [accountScope, confirmedClerkSession]);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      isAuthenticated: !!user,
      authMode: config?.authMode ?? null,
      emailCodeEnabled: config?.emailCodeEnabled ?? true,
      clerkEnabled: config?.clerkEnabled ?? false,
      clerkReady,
      hasClerkPublishableKey,
      loading,
      credentialsReady,
      credentialsKey,
      requestLoginCode,
      verifyLoginCode,
      loginWithGoogle,
      prepareGoogleSignIn,
      logout,
      deleteAccount,
      refreshUser
    }),
    [
      clerkReady,
      config,
      credentialsKey,
      credentialsReady,
      deleteAccount,
      hasClerkPublishableKey,
      loading,
      loginWithGoogle,
      logout,
      prepareGoogleSignIn,
      refreshUser,
      requestLoginCode,
      user,
      verifyLoginCode
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
