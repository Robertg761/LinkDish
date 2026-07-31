import { ClerkProvider } from "@clerk/clerk-react";
import React from "react";

import { AuthProvider } from "../auth/AuthProvider";

const clerkPublishableKey = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) || "";

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (clerkPublishableKey) {
    return (
      <ClerkProvider publishableKey={clerkPublishableKey}>
        <AuthProvider>{children}</AuthProvider>
      </ClerkProvider>
    );
  }
  
  return <AuthProvider>{children}</AuthProvider>;
};
