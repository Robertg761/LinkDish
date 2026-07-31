import { useAuth } from "@clerk/expo";
import { useMemo, type PropsWithChildren } from "react";

import { ClerkSessionContextProvider } from "./ClerkSessionContext";

export const ClerkSessionBridge = ({ children }: PropsWithChildren) => {
  const { getToken, isLoaded, isSignedIn, signOut } = useAuth();
  const value = useMemo(
    () => ({
      getToken: async () => (isSignedIn ? await getToken() : null),
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      signOut: async () => {
        await signOut();
      }
    }),
    [getToken, isLoaded, isSignedIn, signOut]
  );

  return <ClerkSessionContextProvider value={value}>{children}</ClerkSessionContextProvider>;
};
