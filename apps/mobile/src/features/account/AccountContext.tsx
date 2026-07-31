import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";

import { mobileEnv } from "../../config/env";

import { useClerkSession } from "./ClerkSessionContext";

import type {
  AccountUser,
  AuthConfigResponse,
  UpdateAccountProfileRequest
} from "@linkdish/api-contracts";

interface AccountContextValue {
  accountError: string | null;
  authMode: AuthConfigResponse["authMode"];
  clearAccountError: () => void;
  deleteAccount: (confirmEmail: string) => Promise<void>;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getAuthToken: () => Promise<string | null>;
  hasLoadedAccount: boolean;
  isAccountBusy: boolean;
  isClerkSignInEnabled: boolean;
  isEmailCodeSignInEnabled: boolean;
  isSignedIn: boolean;
  logout: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  requestCode: (email: string) => Promise<void>;
  sessionToken: string | null;
  signInWithDebugHousehold: () => Promise<void>;
  updateProfile: (profile: UpdateAccountProfileRequest) => Promise<void>;
  user: AccountUser | null;
  verifyCode: (
    email: string,
    code: string,
    profile?: Partial<UpdateAccountProfileRequest>
  ) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);
const SESSION_TOKEN_STORAGE_KEY = "linkdish.account.sessionToken";
const defaultAuthConfig: AuthConfigResponse = {
  authMode: "legacy_email_code",
  clerkEnabled: false,
  emailCodeEnabled: true
};
const hasClerkPublishableKey = Boolean(process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY);
type LoadedAuthConfig = {
  config: AuthConfigResponse;
  isFromServer: boolean;
};

const canUseDebugHouseholdSimulator =
  process.env.NODE_ENV === "test" || (typeof __DEV__ !== "undefined" && __DEV__);

const createClient = (sessionToken?: string | null) =>
  createExtractorApiClient({
    baseUrl: mobileEnv.apiBaseUrl,
    getHeaders: () =>
      sessionToken
        ? {
            authorization: `Bearer ${sessionToken}`
          }
        : {}
  });

const createClientWithHeaders = (getHeaders: () => Promise<Record<string, string>>) =>
  createExtractorApiClient({
    baseUrl: mobileEnv.apiBaseUrl,
    getHeaders
  });

const getAccountErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "LinkDish account action failed.";
};

export const AccountProvider = ({ children }: PropsWithChildren) => {
  const clerkSession = useClerkSession();
  const [accountError, setAccountError] = useState<string | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse>(defaultAuthConfig);
  const authConfigRef = useRef<AuthConfigResponse>(defaultAuthConfig);
  const preferLegacySessionRef = useRef(false);
  const [hasLoadedAccount, setHasLoadedAccount] = useState(false);
  const [isAccountBusy, setIsAccountBusy] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [user, setUser] = useState<AccountUser | null>(null);

  const applySessionToken = useCallback(async (nextSessionToken: string | null) => {
    if (nextSessionToken) {
      await SecureStore.setItemAsync(SESSION_TOKEN_STORAGE_KEY, nextSessionToken);
    } else {
      await SecureStore.deleteItemAsync(SESSION_TOKEN_STORAGE_KEY);
    }

    setSessionToken(nextSessionToken);
  }, []);

  const getAuthToken = useCallback(async () => {
    if (clerkSession.isSignedIn && !preferLegacySessionRef.current) {
      return clerkSession.getToken();
    }

    return sessionToken;
  }, [clerkSession, sessionToken]);

  const getAuthHeaders = useCallback(async () => {
    const authToken = await getAuthToken();

    return authToken
      ? {
          authorization: `Bearer ${authToken}`
        }
      : {};
  }, [getAuthToken]);

  const loadAuthConfig = useCallback(async (): Promise<LoadedAuthConfig> => {
    try {
      return {
        config: await createClient().getAuthConfig(),
        isFromServer: true
      };
    } catch (error) {
      console.warn("Failed to load LinkDish auth config.", error);
      return {
        config: authConfigRef.current,
        isFromServer: false
      };
    }
  }, []);

  const loadAccountSession = useCallback(
    async (
      nextAuthConfig = authConfigRef.current,
      options: { allowClerkSignOut: boolean } = { allowClerkSignOut: true }
    ) => {
      if (!clerkSession.isLoaded) {
        return;
      }

      if (
        clerkSession.isSignedIn &&
        nextAuthConfig.clerkEnabled &&
        !preferLegacySessionRef.current
      ) {
        preferLegacySessionRef.current = false;
        await applySessionToken(null);

        const session = await createClientWithHeaders(async () => {
          const clerkToken = await clerkSession.getToken();

          return clerkToken
            ? {
                authorization: `Bearer ${clerkToken}`
              }
            : {};
        }).getSession();

        setUser(session.authenticated ? session.user : null);
        return;
      }

      if (clerkSession.isSignedIn && options.allowClerkSignOut) {
        await clerkSession.signOut();
      }

      const storedSessionToken = await SecureStore.getItemAsync(SESSION_TOKEN_STORAGE_KEY);

      if (!storedSessionToken) {
        setSessionToken(null);
        setUser(null);
        return;
      }

      setSessionToken(storedSessionToken);

      const session = await createClient(storedSessionToken).getSession();

      if (!session.authenticated) {
        await applySessionToken(null);
        setUser(null);
        return;
      }

      setSessionToken(storedSessionToken);
      setUser(session.user);
    },
    [applySessionToken, clerkSession]
  );

  useEffect(() => {
    let isMounted = true;

    const hydrateAccount = async () => {
      try {
        const nextAuthConfig = await loadAuthConfig();

        if (isMounted && nextAuthConfig.isFromServer) {
          authConfigRef.current = nextAuthConfig.config;
          setAuthConfig(nextAuthConfig.config);
        }

        await loadAccountSession(nextAuthConfig.config, {
          allowClerkSignOut: nextAuthConfig.isFromServer
        });
      } catch (error) {
        console.warn("Failed to hydrate LinkDish account.", error);

        if (isMounted) {
          setAccountError(getAccountErrorMessage(error));
        }
      } finally {
        if (isMounted) {
          setHasLoadedAccount(true);
        }
      }
    };

    if (clerkSession.isLoaded) {
      void hydrateAccount();
    }

    return () => {
      isMounted = false;
    };
  }, [clerkSession.isLoaded, loadAccountSession, loadAuthConfig]);

  const value = useMemo<AccountContextValue>(
    () => ({
      accountError,
      authMode: authConfig.authMode,
      clearAccountError: () => setAccountError(null),
      deleteAccount: async (confirmEmail) => {
        if (!user) {
          return;
        }

        setAccountError(null);
        setIsAccountBusy(true);

        try {
          await createClientWithHeaders(getAuthHeaders).deleteAccount({ confirmEmail });
          if (clerkSession.isSignedIn) {
            await clerkSession.signOut();
          }
          preferLegacySessionRef.current = false;
          await applySessionToken(null);
          setUser(null);
        } catch (error) {
          setAccountError(getAccountErrorMessage(error));
          throw error;
        } finally {
          setIsAccountBusy(false);
        }
      },
      getAuthHeaders,
      getAuthToken,
      hasLoadedAccount,
      isAccountBusy,
      isClerkSignInEnabled: hasClerkPublishableKey && authConfig.clerkEnabled,
      isEmailCodeSignInEnabled: authConfig.emailCodeEnabled,
      isSignedIn: Boolean(user),
      logout: async () => {
        setAccountError(null);
        setIsAccountBusy(true);

        try {
          if (sessionToken) {
            await createClient(sessionToken).logout();
          }
          if (clerkSession.isSignedIn) {
            await clerkSession.signOut();
          }
        } catch (error) {
          console.warn("Failed to clear LinkDish server session during sign-out.", error);
          setAccountError(getAccountErrorMessage(error));
        } finally {
          preferLegacySessionRef.current = false;
          await applySessionToken(null);
          setUser(null);
          setIsAccountBusy(false);
        }
      },
      refreshAccount: async () => {
        setAccountError(null);
        setIsAccountBusy(true);

        try {
          await loadAccountSession();
        } catch (error) {
          setAccountError(getAccountErrorMessage(error));
          throw error;
        } finally {
          setIsAccountBusy(false);
        }
      },
      requestCode: async (email) => {
        setAccountError(null);
        setIsAccountBusy(true);

        try {
          await createClient().requestLoginCode({ email });
        } catch (error) {
          setAccountError(getAccountErrorMessage(error));
          throw error;
        } finally {
          setIsAccountBusy(false);
        }
      },
      sessionToken,
      signInWithDebugHousehold: canUseDebugHouseholdSimulator
        ? async () => {
            type DebugHouseholdSimulationResponse = {
              expiresAt: string;
              household: unknown;
              recipes: unknown[];
              sessionToken: string;
              user: AccountUser;
            };

            const readJsonResponse = async (response: Response): Promise<unknown> => {
              const rawBody = await response.text();

              try {
                return rawBody ? (JSON.parse(rawBody) as unknown) : null;
              } catch {
                return rawBody;
              }
            };

            const parseDebugHouseholdSimulation = (
              body: unknown
            ): DebugHouseholdSimulationResponse => {
              if (
                typeof body === "object" &&
                body !== null &&
                "sessionToken" in body &&
                typeof (body as { sessionToken?: unknown }).sessionToken === "string" &&
                "user" in body &&
                typeof (body as { user?: unknown }).user === "object" &&
                (body as { user?: unknown }).user !== null
              ) {
                return body as DebugHouseholdSimulationResponse;
              }

              throw new Error("The debug household simulator returned an unexpected response.");
            };

            setAccountError(null);

            if (!mobileEnv.debugHouseholdSimulatorEnabled) {
              const error = new Error(
                "The debug household simulator is not enabled for this build."
              );
              setAccountError(error.message);
              throw error;
            }

            setIsAccountBusy(true);

            try {
              const response = await fetch(
                `${mobileEnv.apiBaseUrl.replace(/\/+$/u, "")}/debug/household/full`,
                {
                  method: "POST"
                }
              );
              const body = await readJsonResponse(response);

              if (!response.ok) {
                throw new ExtractorApiError(
                  "Debug household simulator request failed.",
                  response.status,
                  body
                );
              }

              const simulation = parseDebugHouseholdSimulation(body);

              preferLegacySessionRef.current = true;
              if (clerkSession.isSignedIn) {
                await clerkSession.signOut();
              }

              await applySessionToken(simulation.sessionToken);
              setUser(simulation.user);
            } catch (error) {
              setAccountError(getAccountErrorMessage(error));
              throw error;
            } finally {
              setIsAccountBusy(false);
            }
          }
        : () => {
            const error = new Error("This sign-in path is unavailable for this build.");
            setAccountError(error.message);
            return Promise.reject(error);
          },
      updateProfile: async (profile) => {
        if (!user) {
          return;
        }

        setAccountError(null);
        setIsAccountBusy(true);

        try {
          const response =
            await createClientWithHeaders(getAuthHeaders).updateAccountProfile(profile);
          setUser({
            ...response.user,
            billingPlan: response.user.billingPlan ?? user.billingPlan
          });
        } catch (error) {
          setAccountError(getAccountErrorMessage(error));
          throw error;
        } finally {
          setIsAccountBusy(false);
        }
      },
      user,
      verifyCode: async (email, code, profile) => {
        setAccountError(null);
        setIsAccountBusy(true);

        try {
          const response = await createClient().verifyLoginCode({
            code,
            email,
            ...profile
          });
          preferLegacySessionRef.current = true;
          await applySessionToken(response.sessionToken);
          setUser(response.user);
        } catch (error) {
          setAccountError(getAccountErrorMessage(error));
          throw error;
        } finally {
          setIsAccountBusy(false);
        }
      }
    }),
    [
      accountError,
      applySessionToken,
      authConfig,
      clerkSession,
      getAuthHeaders,
      getAuthToken,
      hasLoadedAccount,
      isAccountBusy,
      loadAccountSession,
      sessionToken,
      user
    ]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
};

export const useAccount = () => {
  const context = useContext(AccountContext);

  if (!context) {
    throw new Error("useAccount must be used within AccountProvider.");
  }

  return context;
};
