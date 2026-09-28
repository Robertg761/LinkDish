import { render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLegacySessionToken, setLegacySessionToken } from "./auth-storage";
import { AuthProvider } from "./AuthProvider";
import {
  publishClerkState,
  registerClerkControls,
  requestClerk,
  resetClerkBridgeForTests
} from "./clerk-bridge";

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

// The Clerk bridge chunk is never rendered here; these tests drive the bridge store directly.
vi.mock("@clerk/clerk-react", () => {
  throw new Error("AuthProvider must not import @clerk/clerk-react");
});

const clerkControls = {
  authenticateWithRedirect: vi.fn(),
  getToken: vi.fn<() => Promise<string | null>>(),
  signOut: vi.fn()
};

describe("AuthProvider Clerk token bridge", () => {
  beforeEach(() => {
    localStorage.clear();
    resetClerkBridgeForTests();
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
    clerkControls.getToken.mockReset();
    clerkControls.getToken.mockResolvedValue(null);
    clerkControls.signOut.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    resetClerkBridgeForTests();
  });

  it("does not use a stale legacy email-code token when Clerk is signed in", async () => {
    setLegacySessionToken("legacy_account_a_token");
    requestClerk("session_hint");
    registerClerkControls(clerkControls);
    publishClerkState({ isLoaded: true, isSignedIn: true, signInReady: true });

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
    expect(clerkControls.getToken).toHaveBeenCalled();
    expect(getLegacySessionToken()).toBeNull();
  });

  it("sends the Clerk token once the bridge reports a signed-in session", async () => {
    clerkControls.getToken.mockResolvedValue("clerk_jwt");
    requestClerk("session_hint");
    registerClerkControls(clerkControls);
    publishClerkState({ isLoaded: true, isSignedIn: true, signInReady: true });

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

    await expect(tokenProvider?.()).resolves.toBe("clerk_jwt");
  });

  it("falls back to the legacy token while Clerk is not mounted", async () => {
    setLegacySessionToken("legacy_token");

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

    await expect(tokenProvider?.()).resolves.toBe("legacy_token");
    expect(clerkControls.getToken).not.toHaveBeenCalled();
  });
});
