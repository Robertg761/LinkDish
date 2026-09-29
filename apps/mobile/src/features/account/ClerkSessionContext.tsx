import React, { createContext, useContext, type PropsWithChildren } from "react";

interface ClerkSessionContextValue {
  getToken: () => Promise<string | null>;
  isLoaded: boolean;
  isSignedIn: boolean;
  /**
   * Clerk's active session (null signed out). Clerk can switch straight to another account's
   * session with `isSignedIn` staying true; this changes when it does.
   */
  sessionId: string | null;
  /** Ends Clerk session `sessionId` only, when given; otherwise Clerk's active session. */
  signOut: (sessionId?: string) => Promise<void>;
}

const noopContext: ClerkSessionContextValue = {
  getToken: () => Promise.resolve(null),
  isLoaded: true,
  isSignedIn: false,
  sessionId: null,
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
