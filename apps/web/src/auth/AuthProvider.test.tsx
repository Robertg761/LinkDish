import { render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLegacySessionToken, setLegacySessionToken } from "./auth-storage";
import { AuthProvider } from "./AuthProvider";

const apiClientMocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  getSession: vi.fn(),
  registerAuthTokenProvider: vi.fn()
}));

vi.mock("../api/client", () => ({
  apiClient: {
    getAuthConfig: apiClientMocks.getAuthConfig,
    getSession: apiClientMocks.getSession
  },
  registerAuthTokenProvider: apiClientMocks.registerAuthTokenProvider
}));

const clerkMocks = vi.hoisted(() => ({
  auth: {
    getToken: vi.fn(),
    isLoaded: true,
    isSignedIn: true,
    signOut: vi.fn()
  },
  signIn: {
    isLoaded: true,
    signIn: {
      authenticateWithRedirect: vi.fn()
    }
  }
}));

vi.mock("@clerk/clerk-react", () => ({
  useAuth: () => clerkMocks.auth,
  useSignIn: () => clerkMocks.signIn
}));

describe("AuthProvider Clerk token bridge", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test");
    apiClientMocks.getAuthConfig.mockReset();
    apiClientMocks.getAuthConfig.mockResolvedValue({
      authMode: "clerk_beta",
      clerkEnabled: true,
      emailCodeEnabled: true
    });
    apiClientMocks.getSession.mockReset();
    apiClientMocks.getSession.mockResolvedValue({
      authenticated: false
    });
    apiClientMocks.registerAuthTokenProvider.mockReset();
    clerkMocks.auth.getToken.mockReset();
    clerkMocks.auth.getToken.mockResolvedValue(null);
    clerkMocks.auth.isSignedIn = true;
    clerkMocks.auth.signOut.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("does not use a stale legacy email-code token when Clerk is signed in", async () => {
    setLegacySessionToken("legacy_account_a_token");

    render(
      <AuthProvider>
        <div>auth child</div>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(apiClientMocks.registerAuthTokenProvider).toHaveBeenCalled();
    });

    const tokenProvider = apiClientMocks.registerAuthTokenProvider.mock.calls.at(-1)?.[0] as
      | (() => Promise<string | null>)
      | undefined;

    await expect(tokenProvider?.()).resolves.toBeNull();
    expect(getLegacySessionToken()).toBeNull();
  });
});
