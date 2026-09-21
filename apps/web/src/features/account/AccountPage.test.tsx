import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  user: null as {
    avatarEmoji?: string | null;
    billingPlan?: string;
    displayName?: string | null;
    email: string;
    id: string;
  } | null,
  verifyLoginCode: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    updateAccountProfile: vi.fn()
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    user: authMocks.user,
    isAuthenticated: Boolean(authMocks.user),
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
    authMocks.user = null;
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

  it("gives the sign-in fields accessible names", () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    expect(screen.getByRole("textbox", { name: /email address/i })).toBeInTheDocument();
  });

  it("gives the verification code input an accessible name", async () => {
    authMocks.requestLoginCode.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole("textbox", { name: /email address/i }), {
      target: { value: "cook@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: /email sign-in code/i }));

    expect(
      await screen.findByRole("textbox", { name: /6-digit verification code/i })
    ).toBeInTheDocument();
  });
});

describe("AccountPage account deletion", () => {
  beforeEach(() => {
    authMocks.clerkEnabled = true;
    authMocks.clerkReady = true;
    authMocks.deleteAccount.mockReset();
    authMocks.deleteAccount.mockResolvedValue(undefined);
    authMocks.hasClerkPublishableKey = true;
    authMocks.refreshUser.mockReset();
    authMocks.user = {
      avatarEmoji: null,
      billingPlan: "free",
      displayName: "Cook",
      email: "Cook@Example.com",
      id: "user_1"
    };
  });

  const openDeleteForm = () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
  };

  it("accepts the confirmation email in any casing", async () => {
    openDeleteForm();

    const confirmField = screen.getByRole("textbox", { name: /confirm your email/i });
    fireEvent.change(confirmField, { target: { value: "cook@example.com" } });

    const submitButton = screen.getByRole("button", { name: /delete account/i });
    expect(submitButton).toBeEnabled();

    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(authMocks.deleteAccount).toHaveBeenCalledWith("cook@example.com");
    });
    expect(
      screen.queryByText("Email address does not match your current account email.")
    ).not.toBeInTheDocument();
  });

  it("still rejects a different email address", async () => {
    openDeleteForm();

    fireEvent.change(screen.getByRole("textbox", { name: /confirm your email/i }), {
      target: { value: "someone@else.com" }
    });

    const form = screen.getByRole("textbox", { name: /confirm your email/i }).closest("form");
    fireEvent.submit(form!);

    expect(
      await screen.findByText("Email address does not match your current account email.")
    ).toBeInTheDocument();
    expect(authMocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("gives the profile and delete fields accessible names", () => {
    openDeleteForm();

    expect(screen.getByRole("textbox", { name: /display name/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /confirm your email/i })).toBeInTheDocument();
  });
});
