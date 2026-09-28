import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { ToastProvider } from "../../components/Toast";

import { AccountPage, getPostSignInDestination } from "./AccountPage";

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
    billingPlan?: "free" | "plus" | "family";
    displayName?: string | null;
    email: string;
    id: string;
  } | null,
  verifyLoginCode: vi.fn()
}));

const apiMocks = vi.hoisted(() => ({
  getBillingUsage: vi.fn(),
  updateAccountProfile: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    getBillingUsage: apiMocks.getBillingUsage,
    updateAccountProfile: apiMocks.updateAccountProfile
  }
}));

const libraryMocks = vi.hoisted(() => ({
  recipes: [] as Array<{ id: string; isStarter?: boolean }>
}));

vi.mock("../../data/library-store", () => ({
  useSavedRecipes: () => ({
    error: null,
    recipes: libraryMocks.recipes,
    retry: vi.fn(),
    status: "ready"
  })
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

const LocationProbe = () => {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
};

const renderAccount = (entry = "/account") =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );

const resetAuth = () => {
  authMocks.clerkEnabled = true;
  authMocks.clerkReady = true;
  authMocks.deleteAccount.mockReset();
  authMocks.hasClerkPublishableKey = true;
  authMocks.loginWithGoogle.mockReset();
  authMocks.logout.mockReset();
  authMocks.logout.mockResolvedValue(undefined);
  authMocks.refreshUser.mockReset();
  authMocks.requestLoginCode.mockReset();
  authMocks.user = null;
  authMocks.verifyLoginCode.mockReset();
  apiMocks.getBillingUsage.mockReset();
  apiMocks.getBillingUsage.mockResolvedValue({ billingEnabled: false });
};

describe("post sign-in destinations", () => {
  it("keeps invite and upgrade intent, including the billing period", () => {
    expect(getPostSignInDestination(new URLSearchParams("invite=Ab Cd"))).toBe(
      "/household?invite=Ab%20Cd"
    );
    expect(getPostSignInDestination(new URLSearchParams("upgrade=family"))).toBe(
      "/pricing?upgrade=family"
    );
    expect(getPostSignInDestination(new URLSearchParams("upgrade=plus&period=monthly"))).toBe(
      "/pricing?upgrade=plus&period=monthly"
    );
    expect(getPostSignInDestination(new URLSearchParams("upgrade=gold"))).toBeNull();
    expect(getPostSignInDestination(new URLSearchParams(""))).toBeNull();
  });
});

describe("AccountPage sign-in", () => {
  beforeEach(resetAuth);

  it("shows and starts Google sign-in when Clerk is configured for the web build", () => {
    renderAccount();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to LinkDish");
    const googleButton = screen.getByRole("button", { name: /continue with google/i });

    expect(googleButton).toBeEnabled();
    fireEvent.click(googleButton);
    expect(authMocks.loginWithGoogle).toHaveBeenCalledWith("/");
  });

  it("keeps the Google option visible with a clear unavailable state when the web build lacks the Clerk key", () => {
    authMocks.hasClerkPublishableKey = false;

    renderAccount();

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByText(/google sign-in is temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign-in code/i })).toBeEnabled();
  });

  it("keeps email sign-in usable while Clerk is still initializing", () => {
    authMocks.clerkReady = false;

    renderAccount();

    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /sign-in code/i })).toBeEnabled();
  });

  it("hides Google sign-in when the API has Clerk disabled", () => {
    authMocks.clerkEnabled = false;

    renderAccount();

    expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign-in code/i })).toBeEnabled();
  });

  it("passes the chosen plan through Google sign-in and explains why", () => {
    renderAccount("/account?upgrade=family");

    expect(screen.getByText(/Sign in to continue to Family/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(authMocks.loginWithGoogle).toHaveBeenCalledWith("/pricing?upgrade=family");
  });

  it("sends signed-in people on to the plan they picked", async () => {
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };

    renderAccount("/account?upgrade=plus&period=monthly");

    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/pricing?upgrade=plus&period=monthly"
    );
  });

  it("walks through the email code with plain-language errors", async () => {
    authMocks.requestLoginCode.mockResolvedValue(undefined);
    authMocks.verifyLoginCode.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 401, { message: "bad code" })
    );

    renderAccount();

    const email = screen.getByRole("textbox", { name: /email address/i });
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /sign-in code/i }));
    expect(await screen.findByText(/Enter your email address/u)).toBeVisible();
    expect(authMocks.requestLoginCode).not.toHaveBeenCalled();

    fireEvent.change(email, { target: { value: "cook@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /sign-in code/i }));

    const codeField = await screen.findByRole("textbox", { name: /6-digit code/i });
    expect(screen.getByText("cook@example.com")).toBeVisible();
    fireEvent.change(codeField, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn't work.");
    expect(authMocks.verifyLoginCode).toHaveBeenCalledWith("cook@example.com", "123456");
    expect(screen.queryByText("Extractor API request failed.")).not.toBeInTheDocument();
  });
});

describe("AccountPage signed in", () => {
  beforeEach(() => {
    resetAuth();
    authMocks.user = {
      avatarEmoji: null,
      billingPlan: "free",
      displayName: "Sam Rivera",
      email: "Cook@Example.com",
      id: "user_1"
    };
    libraryMocks.recipes = [
      { id: "starter-1", isStarter: true },
      { id: "recipe-1" },
      { id: "recipe-2" }
    ];
    apiMocks.updateAccountProfile.mockReset();
    apiMocks.updateAccountProfile.mockResolvedValue({ user: authMocks.user });
  });

  it("shows the profile, plan usage and quick links", () => {
    renderAccount();

    expect(screen.getByRole("heading", { level: 1, name: "Sam Rivera" })).toBeVisible();
    expect(screen.getByText("SR")).toBeVisible();
    expect(screen.getByRole("heading", { name: /LinkDish Free/u })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Saved recipes" })).toHaveAttribute(
      "aria-valuenow",
      "2"
    );
    expect(screen.getByText("2 of 15")).toBeVisible();
    expect(screen.getByRole("link", { name: /Upgrade to Plus/u })).toHaveAttribute(
      "href",
      "/pricing?upgrade=plus"
    );

    const links = within(screen.getByRole("navigation", { name: "Account links" }));
    for (const label of [
      "Settings",
      "Household",
      "Your data",
      "Install app",
      "Support",
      "Privacy"
    ]) {
      expect(links.getByRole("link", { name: new RegExp(label, "u") })).toBeVisible();
    }
    // Shopping is a tab already; the grid doesn't repeat it.
    expect(links.queryByRole("link", { name: /Shopping list/u })).not.toBeInTheDocument();
  });

  it("shows the true count past the free limit, with starters explained", () => {
    libraryMocks.recipes = [
      ...Array.from({ length: 17 }, (_, index) => ({ id: `recipe-${index}` })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `starter-${index}`, isStarter: true }))
    ];

    renderAccount();

    expect(screen.getByText("17 of 15")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Saved recipes" })).toHaveAttribute(
      "aria-valuetext",
      "17 of 15 used"
    );
    expect(
      screen.getByText(
        "2 over the free limit. They all stay; new saves need Plus. 3 starter recipes don't count."
      )
    ).toBeVisible();
  });

  it("gives paid plans the same usage meter, for this month's imports", async () => {
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    apiMocks.getBillingUsage.mockResolvedValue({
      billingEnabled: true,
      quota: {
        limit: 100,
        meteringMode: "paid_monthly",
        monthlyLimit: 100,
        remaining: 96,
        remainingThisMonth: 96,
        resetsAt: "2026-10-01T12:00:00.000Z"
      }
    });

    renderAccount();

    // The meter holds its place while the usage loads, so the plan card doesn't jump.
    expect(screen.getByRole("progressbar", { name: "Imports used this month" })).toHaveAttribute(
      "aria-valuetext",
      "Loading"
    );
    expect(await screen.findByText("4 of 100")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Imports used this month" })).toHaveAttribute(
      "aria-valuenow",
      "4"
    );
    expect(screen.getByText(/^Resets /u)).toBeVisible();
    expect(screen.queryByRole("progressbar", { name: "Saved recipes" })).not.toBeInTheDocument();
  });

  it("points Family accounts at their household", async () => {
    authMocks.user = { billingPlan: "family", email: "cook@example.com", id: "user_1" };

    renderAccount();

    expect(screen.getByRole("heading", { name: /LinkDish Family/u })).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage household" })).toHaveAttribute(
      "href",
      "/household"
    );
    // Billing is off in this test, so the placeholder meter goes once usage has answered.
    await waitFor(() => {
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });

  it("edits the profile in a sheet", async () => {
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const sheet = screen.getByRole("dialog", { name: "Edit profile" });
    const name = within(sheet).getByRole("textbox", { name: /display name/i });
    expect(name).toHaveValue("Sam Rivera");

    fireEvent.change(name, { target: { value: "Sam R." } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Use 🍜" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save profile" }));

    await waitFor(() => {
      expect(apiMocks.updateAccountProfile).toHaveBeenCalledWith({
        avatarEmoji: "🍜",
        displayName: "Sam R."
      });
    });
    expect(authMocks.refreshUser).toHaveBeenCalled();
    expect(await screen.findByText("Profile saved")).toBeVisible();
  });

  it("signs out", async () => {
    renderAccount();

    const signOut = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(signOut);
    expect(authMocks.logout).toHaveBeenCalled();
    await waitFor(() => expect(signOut).not.toHaveAttribute("aria-busy"));
  });
});

describe("AccountPage account deletion", () => {
  beforeEach(() => {
    resetAuth();
    authMocks.deleteAccount.mockResolvedValue(undefined);
    authMocks.user = {
      avatarEmoji: null,
      billingPlan: "free",
      displayName: "Cook",
      email: "Cook@Example.com",
      id: "user_1"
    };
  });

  const openDeleteForm = () => {
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: /delete account/i }));
  };

  it("explains the consequences before anything is deleted", () => {
    openDeleteForm();

    const section = screen.getByRole("region", { name: "Delete your account?" });
    expect(section).toHaveTextContent("Recipes saved in this browser stay on this device.");
    expect(section).toHaveTextContent("doesn't cancel a subscription");
    expect(screen.getByRole("button", { name: /delete account/i })).toBeDisabled();
    expect(authMocks.deleteAccount).not.toHaveBeenCalled();
  });

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

  it("gives the delete field an accessible name and can be backed out of", () => {
    openDeleteForm();

    expect(screen.getByRole("textbox", { name: /confirm your email/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    expect(screen.queryByRole("textbox", { name: /confirm your email/i })).not.toBeInTheDocument();
  });
});
