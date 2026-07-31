import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountPage } from "./AccountPage";

const authMocks = vi.hoisted(() => ({
  clerkEnabled: true,
  clerkReady: true,
  deleteAccount: vi.fn(),
  hasClerkPublishableKey: true,
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  requestLoginCode: vi.fn(),
  verifyLoginCode: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    updateAccountProfile: vi.fn()
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    authMode: "clerk_beta",
    emailCodeEnabled: true,
    clerkEnabled: authMocks.clerkEnabled,
    clerkReady: authMocks.clerkReady,
    hasClerkPublishableKey: authMocks.hasClerkPublishableKey,
    loading: false,
    requestLoginCode: authMocks.requestLoginCode,
    verifyLoginCode: authMocks.verifyLoginCode,
    loginWithGoogle: authMocks.loginWithGoogle,
    logout: authMocks.logout,
    deleteAccount: authMocks.deleteAccount,
    refreshUser: authMocks.refreshUser
  })
}));

describe("AccountPage auth options", () => {
  beforeEach(() => {
    authMocks.clerkEnabled = true;
    authMocks.clerkReady = true;
    authMocks.deleteAccount.mockReset();
    authMocks.hasClerkPublishableKey = true;
    authMocks.loginWithGoogle.mockReset();
    authMocks.logout.mockReset();
    authMocks.refreshUser.mockReset();
    authMocks.requestLoginCode.mockReset();
    authMocks.verifyLoginCode.mockReset();
  });

  it("shows and starts Google sign-in when Clerk is configured for the web build", () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    const googleButton = screen.getByRole("button", { name: /continue with google/i });

    expect(googleButton).toBeEnabled();
    fireEvent.click(googleButton);
    expect(authMocks.loginWithGoogle).toHaveBeenCalledWith("/");
  });

  it("keeps the Google option visible with a clear unavailable state when the web build lacks the Clerk key", () => {
    authMocks.hasClerkPublishableKey = false;

    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    const googleButton = screen.getByRole("button", { name: /continue with google/i });

    expect(googleButton).toBeDisabled();
    expect(screen.getByText(/google sign-in is temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /email sign-in code/i })).toBeEnabled();
  });

  it("keeps email sign-in usable while Clerk is still initializing", () => {
    authMocks.clerkReady = false;

    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByText(/google sign-in is temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /email sign-in code/i })).toBeEnabled();
  });

  it("hides Google sign-in when the API has Clerk disabled", () => {
    authMocks.clerkEnabled = false;

    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /email sign-in code/i })).toBeEnabled();
  });

  it("passes upgrade intent through Google sign-in", () => {
    render(
      <MemoryRouter initialEntries={["/account?upgrade=family"]}>
        <AccountPage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(authMocks.loginWithGoogle).toHaveBeenCalledWith("/pricing");
  });
});
