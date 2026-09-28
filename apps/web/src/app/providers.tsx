import React from "react";

import { AuthProvider } from "../auth/AuthProvider";
import { ClerkBridgeHost } from "../auth/ClerkBridgeHost";

/**
 * App-wide providers. Clerk is not one of them: the lazily loaded Clerk bridge renders *next to*
 * the app (never around it) only when a Clerk session may exist or sign-in starts, so loading it
 * never remounts the app. Must render inside the router.
 */
export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AuthProvider>
    {children}
    <ClerkBridgeHost />
  </AuthProvider>
);
