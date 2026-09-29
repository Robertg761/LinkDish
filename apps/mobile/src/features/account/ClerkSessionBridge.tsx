import { useAuth } from "@clerk/expo";
import { useMemo, type PropsWithChildren } from "react";

import { ClerkSessionContextProvider } from "./ClerkSessionContext";

export const ClerkSessionBridge = ({ children }: PropsWithChildren) => {
  const { getToken, isLoaded, isSignedIn, sessionId, signOut } = useAuth();
  // A switch straight to another account's session leaves isSignedIn true; the session id says so.
  const activeSessionId = isSignedIn ? (sessionId ?? null) : null;
  const value = useMemo(
    () => ({
      getToken: async () => (isSignedIn ? await getToken() : null),
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      sessionId: activeSessionId,
      signOut: async () => {
        await signOut();
      }
    }),
    [activeSessionId, getToken, isLoaded, isSignedIn, signOut]
  );

  return <ClerkSessionContextProvider value={value}>{children}</ClerkSessionContextProvider>;
};
