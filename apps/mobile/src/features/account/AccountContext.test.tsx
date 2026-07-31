import React from "react";
import { Text } from "react-native";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountProvider, useAccount } from "./AccountContext";

import type { ExtractorApiClient } from "@linkdish/api-client";

const mocks = vi.hoisted(() => ({
  createExtractorApiClient: vi.fn(),
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}));

const clerkSessionState = vi.hoisted(() => ({
  getToken: vi.fn(),
  isLoaded: true,
  isSignedIn: false,
  signOut: vi.fn()
}));

const mobileEnvState = vi.hoisted(() => ({
  apiBaseUrl: "http://localhost:3000",
  debugHouseholdSimulatorEnabled: true
}));

vi.mock("react-native", () => ({
  Text: ({ children }: { children: React.ReactNode }) => React.createElement("text", null, children)
}));

vi.mock("../../config/env", () => ({
  mobileEnv: mobileEnvState
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync
}));

vi.mock("@linkdish/api-client", () => ({
  ExtractorApiError: class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
    }
  },
  createExtractorApiClient: mocks.createExtractorApiClient
}));

vi.mock("./ClerkSessionContext", () => ({
  useClerkSession: () => clerkSessionState
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createMockClient = (
  overrides: Partial<Record<keyof ExtractorApiClient, ReturnType<typeof vi.fn>>> = {}
): ExtractorApiClient =>
  ({
    acceptHouseholdInvite: vi.fn(),
    cancelHouseholdInvite: vi.fn(),
    createHousehold: vi.fn(),
    createHouseholdInvite: vi.fn(),
    createWebBillingCheckout: vi.fn(),
    createWebBillingPortal: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue({ status: "deleted" }),
    extractRecipe: vi.fn(),
    getAuthConfig: vi.fn().mockResolvedValue({
      authMode: "legacy_email_code",
      clerkEnabled: false,
      emailCodeEnabled: true
    }),
    getHousehold: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ authenticated: false }),
    getWebBillingAvailability: vi.fn(),
    leaveHousehold: vi.fn(),
    logout: vi.fn().mockResolvedValue({ status: "logged_out" }),
    removeHouseholdMember: vi.fn(),
    requestLoginCode: vi.fn().mockResolvedValue({
      email: "user@example.com",
      expiresInSeconds: 600,
      status: "sent"
    }),
    updateAccountProfile: vi.fn().mockResolvedValue({
      user: {
        avatarEmoji: "🍳",
        displayName: "Robin",
        email: "user@example.com",
        id: "user_123"
      }
    }),
    verifyLoginCode: vi.fn().mockResolvedValue({
      expiresAt: "2026-08-09T10:00:00.000Z",
      sessionToken: "session-token",
      status: "authenticated",
      user: {
        email: "user@example.com",
        id: "user_123"
      }
    }),
    ...overrides
  }) as ExtractorApiClient;

let latestAccount: ReturnType<typeof useAccount> | null = null;

const Probe = () => {
  latestAccount = useAccount();
  return <Text>{latestAccount.user?.email ?? "signed-out"}</Text>;
};

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  latestAccount = null;
  clerkSessionState.getToken.mockReset();
  clerkSessionState.getToken.mockResolvedValue(null);
  clerkSessionState.isLoaded = true;
  clerkSessionState.isSignedIn = false;
  clerkSessionState.signOut.mockReset();
  clerkSessionState.signOut.mockResolvedValue(undefined);
  mocks.createExtractorApiClient.mockReset();
  mocks.deleteItemAsync.mockReset();
  mocks.getItemAsync.mockReset();
  mocks.setItemAsync.mockReset();
  mocks.deleteItemAsync.mockResolvedValue(undefined);
  mocks.getItemAsync.mockResolvedValue(null);
  mocks.setItemAsync.mockResolvedValue(undefined);
  mobileEnvState.apiBaseUrl = "http://localhost:3000";
  mobileEnvState.debugHouseholdSimulatorEnabled = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountContext", () => {
  it("restores a stored session token on startup", async () => {
    const getSession = vi.fn().mockResolvedValue({
      authenticated: true,
      expiresAt: "2026-08-09T10:00:00.000Z",
      user: {
        email: "restored@example.com",
        id: "user_restored"
      }
    });
    const client = createMockClient({
      getAuthConfig: vi.fn().mockResolvedValue({
        authMode: "clerk_beta",
        clerkEnabled: true,
        emailCodeEnabled: true
      }),
      getSession
    });
    mocks.getItemAsync.mockResolvedValue("stored-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    expect(getSession).toHaveBeenCalled();
    expect(latestAccount?.sessionToken).toBe("stored-token");
    expect(latestAccount?.user?.email).toBe("restored@example.com");
  });

  it("uses a Clerk token to restore the backend account when Clerk is signed in", async () => {
    const getSession = vi.fn().mockResolvedValue({
      authenticated: true,
      expiresAt: "2026-08-09T10:00:00.000Z",
      user: {
        email: "clerk@example.com",
        id: "user_clerk"
      }
    });
    const client = createMockClient({
      getAuthConfig: vi.fn().mockResolvedValue({
        authMode: "clerk_beta",
        clerkEnabled: true,
        emailCodeEnabled: true
      }),
      getSession
    });
    clerkSessionState.getToken.mockResolvedValue("clerk-token");
    clerkSessionState.isSignedIn = true;
    mocks.getItemAsync.mockResolvedValue("legacy-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    expect(mocks.deleteItemAsync).toHaveBeenCalledWith("linkdish.account.sessionToken");
    expect(getSession).toHaveBeenCalled();
    expect(latestAccount?.isSignedIn).toBe(true);
    expect(latestAccount?.authMode).toBe("clerk_beta");
    expect(latestAccount?.sessionToken).toBeNull();
    expect(latestAccount?.user?.email).toBe("clerk@example.com");

    const headers = await latestAccount?.getAuthHeaders();
    expect(headers).toEqual({ authorization: "Bearer clerk-token" });
  });

  it("keeps a stored session token when startup session refresh fails", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("Network request failed"));
    const client = createMockClient({
      getSession
    });
    mocks.getItemAsync.mockResolvedValue("stored-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    expect(getSession).toHaveBeenCalled();
    expect(mocks.deleteItemAsync).not.toHaveBeenCalled();
    expect(latestAccount?.sessionToken).toBe("stored-token");
    expect(latestAccount?.accountError).toBe("Network request failed");
  });

  it("stores the session token after code verification", async () => {
    const verifyLoginCode = vi.fn().mockResolvedValue({
      expiresAt: "2026-08-09T10:00:00.000Z",
      sessionToken: "session-token",
      status: "authenticated",
      user: {
        email: "user@example.com",
        id: "user_123"
      }
    });
    const client = createMockClient({
      verifyLoginCode
    });
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await act(async () => {
      await latestAccount?.verifyCode("user@example.com", "211110");
      await flushAsyncWork();
    });

    expect(verifyLoginCode).toHaveBeenCalledWith({
      code: "211110",
      email: "user@example.com"
    });
    expect(mocks.setItemAsync).toHaveBeenCalledWith(
      "linkdish.account.sessionToken",
      "session-token"
    );
    expect(latestAccount?.user?.id).toBe("user_123");
  });

  it("stores the simulator session token after debug household sign-in", async () => {
    clerkSessionState.getToken.mockResolvedValue("clerk-token");
    clerkSessionState.isSignedIn = true;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          expiresAt: "2026-08-09T10:00:00.000Z",
          household: {
            id: "household_debug"
          },
          recipes: [],
          sessionToken: "debug-session-token",
          user: {
            email: "debug-owner@linkdish.test",
            id: "user_debug_owner"
          }
        }),
        {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        }
      )
    );
    const client = createMockClient();
    mocks.createExtractorApiClient.mockReturnValue(client);
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await act(async () => {
      await latestAccount?.signInWithDebugHousehold();
      await flushAsyncWork();
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/debug/household/full", {
      method: "POST"
    });
    expect(mocks.setItemAsync).toHaveBeenCalledWith(
      "linkdish.account.sessionToken",
      "debug-session-token"
    );
    expect(clerkSessionState.signOut).toHaveBeenCalled();
    expect(latestAccount?.user?.email).toBe("debug-owner@linkdish.test");

    const headers = await latestAccount?.getAuthHeaders();
    expect(headers).toEqual({ authorization: "Bearer debug-session-token" });
  });

  it("blocks debug household sign-in when the simulator is disabled for the build", async () => {
    mobileEnvState.debugHouseholdSimulatorEnabled = false;
    const fetchMock = vi.fn();
    const client = createMockClient();
    mocks.createExtractorApiClient.mockReturnValue(client);
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await expect(latestAccount?.signInWithDebugHousehold()).rejects.toThrow(
      "The debug household simulator is not enabled for this build."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the signed-in profile", async () => {
    const updateAccountProfile = vi.fn().mockResolvedValue({
      user: {
        avatarEmoji: "🥘",
        displayName: "Family Cook",
        email: "profile@example.com",
        id: "user_profile"
      }
    });
    const client = createMockClient({
      getSession: vi.fn().mockResolvedValue({
        authenticated: true,
        expiresAt: "2026-08-09T10:00:00.000Z",
        user: {
          avatarEmoji: null,
          billingPlan: "family",
          displayName: null,
          email: "profile@example.com",
          id: "user_profile"
        }
      }),
      updateAccountProfile
    });
    mocks.getItemAsync.mockResolvedValue("stored-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await act(async () => {
      await latestAccount?.updateProfile({
        avatarEmoji: "🥘",
        displayName: "Family Cook"
      });
      await flushAsyncWork();
    });

    expect(updateAccountProfile).toHaveBeenCalledWith({
      avatarEmoji: "🥘",
      displayName: "Family Cook"
    });
    expect(latestAccount?.user?.billingPlan).toBe("family");
    expect(latestAccount?.user?.displayName).toBe("Family Cook");
    expect(latestAccount?.user?.avatarEmoji).toBe("🥘");
  });

  it("deletes the stored session token when the account is deleted", async () => {
    const deleteAccount = vi.fn().mockResolvedValue({ status: "deleted" });
    const client = createMockClient({
      deleteAccount,
      getSession: vi.fn().mockResolvedValue({
        authenticated: true,
        expiresAt: "2026-08-09T10:00:00.000Z",
        user: {
          email: "delete@example.com",
          id: "user_delete"
        }
      })
    });
    mocks.getItemAsync.mockResolvedValue("stored-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await act(async () => {
      await latestAccount?.deleteAccount("delete@example.com");
      await flushAsyncWork();
    });

    expect(deleteAccount).toHaveBeenCalledWith({
      confirmEmail: "delete@example.com"
    });
    expect(mocks.deleteItemAsync).toHaveBeenCalledWith("linkdish.account.sessionToken");
    expect(latestAccount?.user).toBeNull();
  });

  it("clears the local session token even when server logout fails", async () => {
    const logout = vi.fn().mockRejectedValue(new Error("Network request failed"));
    const client = createMockClient({
      getSession: vi.fn().mockResolvedValue({
        authenticated: true,
        expiresAt: "2026-08-09T10:00:00.000Z",
        user: {
          email: "logout@example.com",
          id: "user_logout"
        }
      }),
      logout
    });
    mocks.getItemAsync.mockResolvedValue("stored-token");
    mocks.createExtractorApiClient.mockReturnValue(client);

    await act(async () => {
      create(
        <AccountProvider>
          <Probe />
        </AccountProvider>
      );
      await flushAsyncWork();
    });

    await act(async () => {
      await latestAccount?.logout();
      await flushAsyncWork();
    });

    expect(logout).toHaveBeenCalled();
    expect(mocks.deleteItemAsync).toHaveBeenCalledWith("linkdish.account.sessionToken");
    expect(latestAccount?.user).toBeNull();
    expect(latestAccount?.sessionToken).toBeNull();
  });
});
