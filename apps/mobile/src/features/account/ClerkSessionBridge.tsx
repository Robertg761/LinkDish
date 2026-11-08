import { useAuth, useUser } from "@clerk/expo";
import { useMemo, type PropsWithChildren } from "react";

import { ClerkSessionContextProvider } from "./ClerkSessionContext";

export const ClerkSessionBridge = ({ children }: PropsWithChildren) => {
  const { getToken, isLoaded, isSignedIn, sessionId, signOut } = useAuth();
  const { user } = useUser();
  // Clerk's client SDK names the provider "apple"; its API "oauth_apple".
  const hasAppleAccount = Boolean(
    isSignedIn &&
    user?.externalAccounts.some((account) =>
      ["apple", "oauth_apple"].includes(String(account.provider))
    )
  );
  // A switch straight to another account's session leaves isSignedIn true; the session id says so.
  const activeSessionId = isSignedIn ? (sessionId ?? null) : null;
  const value = useMemo(
    () => ({
      getToken: async () => (isSignedIn ? await getToken() : null),
      hasAppleAccount,
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      sessionId: activeSessionId,
      signOut: async (sessionId?: string) => {
        await signOut(sessionId ? { sessionId } : undefined);
      }
    }),
    [activeSessionId, getToken, hasAppleAccount, isLoaded, isSignedIn, signOut]
  );

  return <ClerkSessionContextProvider value={value}>{children}</ClerkSessionContextProvider>;
};
