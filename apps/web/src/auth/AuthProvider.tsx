import { useAuth as useClerkAuth, useSignIn } from "@clerk/clerk-react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { trackWebEvent } from "../analytics/client";
import { apiClient, registerAuthTokenProvider } from "../api/client";
import { isExtractorApiError } from "../api/errors";

import {
  clearCachedAuthUser,
  readCachedAuthConfig,
  readCachedAuthUser,
  writeCachedAuthConfig,
  writeCachedAuthUser,
  type CachedAuthUserSource
} from "./auth-cache";
import {
  getLegacySessionToken,
  setLegacySessionToken,
  removeLegacySessionToken
} from "./auth-storage";

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
  // Legacy email-code actions
  requestLoginCode: (email: string) => Promise<void>;
  verifyLoginCode: (email: string, code: string) => Promise<void>;
  // Clerk actions
  loginWithGoogle: (redirectUrlComplete?: string) => Promise<void>;
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

/** Which credential the API should see, given the server config and whether Clerk is mounted. */
const getAuthTransport = (
  config: AuthConfigResponse | null,
  hasClerkProvider: boolean
): AuthTransport => {
  if (!config) {
    return "unknown";
  }

  return (config.authMode === "clerk_beta" || config.authMode === "clerk_primary") &&
    config.clerkEnabled &&
    hasClerkProvider
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

function useSafeClerk() {
  try {
    const auth = useClerkAuth();
    const signIn = useSignIn();
    return { auth, signIn };
  } catch {
    return { auth: null, signIn: null };
  }
}

interface InitialAuthState {
  config: AuthConfigResponse | null;
  loading: boolean;
  user: AccountUser | null;
  userSource: CachedAuthUserSource | null;
}

const readInitialAuthState = (hasClerkProvider: boolean): InitialAuthState => {
  const config = readCachedAuthConfig()?.config ?? null;
  const cachedUser = readCachedAuthUser();
  const hasLegacyToken = Boolean(getLegacySessionToken());
  // A cached legacy user without its token is stale; a Clerk user is confirmed once Clerk loads.
  const usable =
    cachedUser && (cachedUser.source === "clerk" ? hasClerkProvider : hasLegacyToken)
      ? cachedUser
      : null;

  if (cachedUser && !usable) {
    clearCachedAuthUser();
  }

  const knownAnonymous =
    !usable && config !== null && getAuthTransport(config, hasClerkProvider) === "legacy"
      ? !hasLegacyToken
      : false;

  return {
    config,
    loading: !usable && !knownAnonymous,
    user: usable?.user ?? null,
    userSource: usable?.source ?? null
  };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { auth: clerkAuth, signIn: clerkSignIn } = useSafeClerk();
  const hasClerkProvider = clerkAuth !== null;
  const hasClerkPublishableKey = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

  const [initial] = useState(() => readInitialAuthState(hasClerkProvider));
  const [config, setConfig] = useState<AuthConfigResponse | null>(initial.config);
  const [configSettled, setConfigSettled] = useState(initial.config !== null);
  const [user, setUserState] = useState<AccountUser | null>(initial.user);
  const [loading, setLoading] = useState(initial.loading);
  const [clerkWaitExpired, setClerkWaitExpired] = useState(false);

  const clerkReady = Boolean(clerkAuth?.isLoaded && clerkSignIn?.isLoaded && clerkSignIn.signIn);
  const clerkLoaded = Boolean(clerkAuth?.isLoaded);
  const clerkSignedIn = Boolean(clerkAuth?.isSignedIn);
  const transport = getAuthTransport(config, hasClerkProvider);

  // Latest values for stable callbacks and the token bridge.
  const clerkAuthRef = useRef(clerkAuth);
  const clerkSignInRef = useRef(clerkSignIn);
  const transportRef = useRef(transport);
  const configRef = useRef(config);
  const userRef = useRef(user);
  const resolveRunRef = useRef(0);
  clerkAuthRef.current = clerkAuth;
  clerkSignInRef.current = clerkSignIn;
  transportRef.current = transport;
  configRef.current = config;
  userRef.current = user;

  const setUser = useCallback((next: AccountUser | null, source?: CachedAuthUserSource) => {
    userRef.current = next;
    setUserState(next);

    if (next && source) {
      writeCachedAuthUser(next, source);
    } else if (!next) {
      clearCachedAuthUser();
    }
  }, []);

  /** Token bridge for every API request (registered once, reads the latest auth state). */
  const getSessionToken = useCallback(async (): Promise<string | null> => {
    const clerk = clerkAuthRef.current;

    if (transportRef.current !== "legacy" && clerk?.isSignedIn) {
      // Clerk beta keeps legacy email-code sessions valid only until Clerk signs in.
      removeLegacySessionToken();

      try {
        return await clerk.getToken();
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
    (result: SessionResult, source: CachedAuthUserSource) => {
      if (result.kind === "user") {
        setUser(result.user, source);
      } else if (result.kind === "signed_out") {
        setUser(null);
      } else {
        // Offline or the API is unreachable: keep whoever we last knew about.
        console.warn("Failed to fetch session:", result.error);
      }
    },
    [setUser]
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
  // on `loading` are not stuck; a cached user is never demoted by this.
  useEffect(() => {
    if (!hasClerkProvider || clerkLoaded || clerkWaitExpired) {
      return;
    }

    const timer = setTimeout(
      () => {
        setClerkWaitExpired(true);
      },
      isBrowserOffline() ? 0 : CLERK_LOAD_TIMEOUT_MS
    );

    return () => {
      clearTimeout(timer);
    };
  }, [clerkLoaded, clerkWaitExpired, hasClerkProvider]);

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
        applySession(result, source);
      }

      finish();
    };

    if (transport === "clerk" || (transport === "unknown" && hasClerkProvider)) {
      if (!clerkLoaded) {
        if (userRef.current) {
          // Optimistic cached user; revalidate once Clerk is ready.
          finish();
          return;
        }

        if (!clerkWaitExpired) {
          // Clerk is still loading: stay in `loading` rather than flashing signed-out UI.
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

      if (clerkSignedIn) {
        removeLegacySessionToken();

        if (!userRef.current) {
          setLoading(true);
        }

        void resolveWith("clerk");
        return;
      }

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
    clerkLoaded,
    clerkSignedIn,
    clerkWaitExpired,
    configSettled,
    hasClerkProvider,
    setUser,
    transport
  ]);

  const refreshUser = useCallback(async () => {
    const source: CachedAuthUserSource =
      transportRef.current !== "legacy" && clerkAuthRef.current?.isSignedIn ? "clerk" : "legacy";
    applySession(await fetchSession(), source);
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

      const clerk = clerkAuthRef.current;

      // If Clerk already has an active session (e.g. from a previous sign-in
      // attempt where the backend was unreachable), try refreshing the backend
      // session first.
      if (clerk?.isSignedIn) {
        removeLegacySessionToken();
        const result = await fetchSession();

        if (result.kind === "user") {
          setUser(result.user, "clerk");
          return;
        }

        // Clerk session exists but backend can't authenticate it (expired JWT,
        // mismatched keys, etc.). Sign out of Clerk and start fresh.
        await clerk.signOut();
      }

      const signIn = clerkSignInRef.current;

      if (!signIn || !signIn.isLoaded || !signIn.signIn) {
        throw new Error("Clerk authentication is not initialized or configured.");
      }
      trackWebEvent({
        eventName: "web_sign_in_started",
        routeOrScreen: "/account",
        properties: {
          auth_mode: "clerk_google"
        }
      });
      await signIn.signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: window.location.origin + "/sso-callback",
        redirectUrlComplete
      });
    },
    [hasClerkPublishableKey, setUser]
  );

  const logout = useCallback(async () => {
    try {
      await apiClient.logout();
    } catch {
      // Ignore network errors on logout
    }

    // Clear legacy token
    removeLegacySessionToken();

    // Clear Clerk if signed in
    const clerk = clerkAuthRef.current;
    if (clerk && clerk.signOut) {
      await clerk.signOut();
    }

    setUser(null);
    trackWebEvent({
      eventName: "web_sign_out_completed",
      routeOrScreen: "/account",
      properties: {}
    });
  }, [setUser]);

  const deleteAccount = useCallback(
    async (email: string) => {
      await apiClient.deleteAccount({ confirmEmail: email });
      await logout();
    },
    [logout]
  );

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
      requestLoginCode,
      verifyLoginCode,
      loginWithGoogle,
      logout,
      deleteAccount,
      refreshUser
    }),
    [
      clerkReady,
      config,
      deleteAccount,
      hasClerkPublishableKey,
      loading,
      loginWithGoogle,
      logout,
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
