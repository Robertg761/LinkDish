import { useAuth as useClerkAuth, useSignIn } from "@clerk/clerk-react";
import React, { createContext, useContext, useState, useEffect } from "react";

import { trackWebEvent } from "../analytics/client";
import { apiClient, registerAuthTokenProvider } from "../api/client";

import {
  getLegacySessionToken,
  setLegacySessionToken,
  removeLegacySessionToken
} from "./auth-storage";

import type { AccountUser, AuthConfigResponse, AuthMode } from "@linkdish/api-contracts";

const AUTH_CONFIG_RETRY_DELAYS_MS = [250, 750];

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

async function getAuthConfigWithRetry(): Promise<AuthConfigResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= AUTH_CONFIG_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await apiClient.getAuthConfig();
    } catch (err) {
      lastError = err;
      const delay = AUTH_CONFIG_RETRY_DELAYS_MS[attempt];

      if (delay == null) {
        break;
      }

      await wait(delay);
    }
  }

  throw lastError;
}

function useSafeClerk() {
  try {
    const auth = useClerkAuth();
    const signIn = useSignIn();
    return { auth, signIn };
  } catch {
    return { auth: null, signIn: null };
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [emailCodeEnabled, setEmailCodeEnabled] = useState(true);
  const [clerkEnabled, setClerkEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const { auth: clerkAuth, signIn: clerkSignIn } = useSafeClerk();
  const hasClerkPublishableKey = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
  const clerkReady = Boolean(clerkAuth?.isLoaded && clerkSignIn?.isLoaded && clerkSignIn.signIn);

  const getClerkSessionToken = async (): Promise<string | null> => {
    if (!clerkAuth?.isSignedIn) {
      return getLegacySessionToken();
    }

    try {
      return await clerkAuth.getToken();
    } catch {
      return null;
    }
  };

  // Refresh LinkDish user session from the backend
  const refreshUser = async () => {
    try {
      const session = await apiClient.getSession();
      if (session.authenticated) {
        setUser(session.user);
      } else {
        setUser(null);
      }
    } catch (err) {
      console.warn("Failed to fetch session:", err);
      setUser(null);
    }
  };

  useEffect(() => {
    async function initAuth() {
      registerAuthTokenProvider(getClerkSessionToken);

      try {
        const config = await getAuthConfigWithRetry();
        setAuthMode(config.authMode);
        setEmailCodeEnabled(config.emailCodeEnabled);
        setClerkEnabled(config.clerkEnabled);

        const isClerkMode =
          (config.authMode === "clerk_beta" || config.authMode === "clerk_primary") &&
          config.clerkEnabled &&
          !!clerkAuth;

        if (isClerkMode) {
          // Clerk beta keeps legacy email-code sessions valid only until Clerk signs in.
          registerAuthTokenProvider(getClerkSessionToken);

          if (clerkAuth.isSignedIn) {
            removeLegacySessionToken();
            await refreshUser();
          } else if (getLegacySessionToken()) {
            await refreshUser();
          } else {
            setUser(null);
          }
        } else {
          // Fall back to legacy email code
          registerAuthTokenProvider(() => getLegacySessionToken());
          const token = getLegacySessionToken();
          if (token) {
            await refreshUser();
          } else {
            setUser(null);
          }
        }
      } catch (err) {
        console.warn("Auth initialization failed:", err);
        registerAuthTokenProvider(getClerkSessionToken);

        if (clerkAuth?.isSignedIn || getLegacySessionToken()) {
          await refreshUser();
        } else {
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    }

    void initAuth();
  }, [clerkAuth?.isSignedIn]);

  const requestLoginCode = async (email: string) => {
    trackWebEvent({
      eventName: "web_sign_in_started",
      routeOrScreen: "/account",
      properties: {
        auth_mode: "email_code"
      }
    });
    await apiClient.requestLoginCode({ email });
  };

  const verifyLoginCode = async (email: string, code: string) => {
    const res = await apiClient.verifyLoginCode({ email, code });
    if (res.status === "authenticated") {
      setLegacySessionToken(res.sessionToken);
      // Re-register legacy token provider
      registerAuthTokenProvider(() => getLegacySessionToken());
      setUser(res.user);
      trackWebEvent({
        eventName: "web_sign_in_completed",
        routeOrScreen: "/account",
        properties: {
          auth_mode: "email_code"
        }
      });
    }
  };

  const loginWithGoogle = async (redirectUrlComplete = "/") => {
    if (!clerkEnabled) {
      throw new Error("Google sign-in is not enabled by the LinkDish API.");
    }

    if (!hasClerkPublishableKey) {
      throw new Error("Google sign-in is not configured for this web app build.");
    }

    // If Clerk already has an active session (e.g. from a previous sign-in
    // attempt where the backend was unreachable), try refreshing the backend
    // session first.
    if (clerkAuth?.isSignedIn) {
      removeLegacySessionToken();
      registerAuthTokenProvider(getClerkSessionToken);
      try {
        const session = await apiClient.getSession();
        if (session.authenticated) {
          setUser(session.user);
          return;
        }
      } catch {
        // Backend unreachable — fall through to sign out and retry
      }
      // Clerk session exists but backend can't authenticate it (expired JWT,
      // mismatched keys, etc.). Sign out of Clerk and start fresh.
      await clerkAuth.signOut();
    }

    if (!clerkSignIn || !clerkSignIn.isLoaded || !clerkSignIn.signIn) {
      throw new Error("Clerk authentication is not initialized or configured.");
    }
    trackWebEvent({
      eventName: "web_sign_in_started",
      routeOrScreen: "/account",
      properties: {
        auth_mode: "clerk_google"
      }
    });
    await clerkSignIn.signIn.authenticateWithRedirect({
      strategy: "oauth_google",
      redirectUrl: window.location.origin + "/sso-callback",
      redirectUrlComplete
    });
  };

  const logout = async () => {
    try {
      await apiClient.logout();
    } catch {
      // Ignore network errors on logout
    }

    // Clear legacy token
    removeLegacySessionToken();
    registerAuthTokenProvider(() => null);

    // Clear Clerk if signed in
    if (clerkAuth && clerkAuth.signOut) {
      await clerkAuth.signOut();
    }

    setUser(null);
    trackWebEvent({
      eventName: "web_sign_out_completed",
      routeOrScreen: "/account",
      properties: {}
    });
  };

  const deleteAccount = async (email: string) => {
    await apiClient.deleteAccount({ confirmEmail: email });
    await logout();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        authMode,
        emailCodeEnabled,
        clerkEnabled,
        clerkReady,
        hasClerkPublishableKey,
        loading,
        requestLoginCode,
        verifyLoginCode,
        loginWithGoogle,
        logout,
        deleteAccount,
        refreshUser
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
