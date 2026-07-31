import React, { createContext, useContext, type PropsWithChildren } from "react";

interface ClerkSessionContextValue {
  getToken: () => Promise<string | null>;
  isLoaded: boolean;
  isSignedIn: boolean;
  signOut: () => Promise<void>;
}

const noopContext: ClerkSessionContextValue = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  isSignedIn: false,
  signOut: () => Promise.resolve()
};

const ClerkSessionContext = createContext<ClerkSessionContextValue>(noopContext);

export const ClerkSessionContextProvider = ({
  children,
  value
}: PropsWithChildren<{ value: ClerkSessionContextValue }>) => (
  <ClerkSessionContext.Provider value={value}>{children}</ClerkSessionContext.Provider>
);

export const NoClerkSessionProvider = ({ children }: PropsWithChildren) => (
  <ClerkSessionContext.Provider value={noopContext}>{children}</ClerkSessionContext.Provider>
);

export const useClerkSession = () => useContext(ClerkSessionContext);
