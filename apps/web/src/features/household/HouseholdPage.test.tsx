import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { getRequestBinding } from "../../api/request-binding";
import { ToastProvider } from "../../components/Toast";

import { HouseholdPage } from "./HouseholdPage";
import { buildWebJoinLink, getInviteCodeProblem, parseInviteInput } from "./invite-links";

import type { HouseholdDetails } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  acceptHouseholdInvite: vi.fn(),
  cancelHouseholdInvite: vi.fn(),
  createHousehold: vi.fn(),
  createHouseholdInvite: vi.fn(),
  getHousehold: vi.fn(),
  leaveHousehold: vi.fn(),
  removeHouseholdMember: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: apiMocks
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  /** A signed-in session whose credentials can't be read yet (a cached Clerk user). */
  credentialsPending: false,
  /** Which credentials requests carry ("clerk" once Clerk signs in late). */
  credentialsSource: "session",
  isAuthenticated: true,
  refreshUser: vi.fn(),
  user: {
    billingPlan: "family" as "free" | "plus" | "family",
    email: "cook@example.com",
    id: "user_1"
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    credentialsKey: authMocks.credentialsPending
      ? null
      : `${authMocks.credentialsSource}:${authMocks.isAuthenticated ? authMocks.user.id : ""}`,
    isAuthenticated: authMocks.isAuthenticated,
    refreshUser: authMocks.refreshUser,
    user: authMocks.isAuthenticated ? authMocks.user : null
  })
}));

const upgradeMocks = vi.hoisted(() => ({
  requestUpgradeSheet: vi.fn()
}));

vi.mock("../upgrade/UpgradeSheet", () => ({
  useUpgradeSheet: () => ({ requestUpgradeSheet: upgradeMocks.requestUpgradeSheet })
}));

const household: HouseholdDetails = {
  activeMemberCount: 3,
  cooldownSlotCount: 0,
  id: "household_1",
  invites: [],
  memberLimit: 6,
  members: [
    {
      email: "cook@example.com",
      joinedAt: "2026-07-01T00:00:00.000Z",
      role: "owner",
      userId: "user_1"
    },
    {
      displayName: "Ana Lopez",
      email: "ana@example.com",
      joinedAt: "2026-07-02T00:00:00.000Z",
      role: "member",
      userId: "user_2"
    },
    {
      email: "jo@example.com",
      joinedAt: "2026-07-03T00:00:00.000Z",
      role: "member",
      userId: "user_3"
    }
  ],
  ownerFamilyEntitlementActive: true,
  ownerUserId: "user_1",
  role: "owner"
};

const householdTree = (entry = "/household") => (
  <ToastProvider>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/household" element={<HouseholdPage />} />
        <Route path="/pricing" element={<h1>Pricing page</h1>} />
        <Route path="/account" element={<h1>Account page</h1>} />
      </Routes>
    </MemoryRouter>
  </ToastProvider>
);

const renderHouseholdPage = (entry = "/household") => render(householdTree(entry));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

describe("invite codes", () => {
  it("accepts codes and invite links and explains bad codes plainly", () => {
    expect(parseInviteInput("  AbCdEfGh1234  ")).toBe("AbCdEfGh1234");
    expect(parseInviteInput("https://linkdish.ca/invite/?code=AbCdEfGh1234")).toBe("AbCdEfGh1234");
    expect(parseInviteInput("app.linkdish.ca/household?invite=AbCdEfGh1234")).toBe("AbCdEfGh1234");
    expect(getInviteCodeProblem("abc")).toMatch(/too short/u);
    expect(getInviteCodeProblem("")).toMatch(/Paste the invite code/u);
    expect(getInviteCodeProblem("has spaces in it")).toMatch(/doesn't look like an invite code/u);
    expect(getInviteCodeProblem("AbCdEfGh1234")).toBeNull();
    expect(buildWebJoinLink("Ab/Cd")).toBe("https://app.linkdish.ca/household?invite=Ab%2FCd");
  });
});

describe("HouseholdPage", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.getHousehold.mockResolvedValue({ household: null });
    authMocks.credentialsPending = false;
    authMocks.credentialsSource = "session";
    authMocks.isAuthenticated = true;
    authMocks.refreshUser.mockReset();
    authMocks.refreshUser.mockResolvedValue(undefined);
    authMocks.user = { billingPlan: "family", email: "cook@example.com", id: "user_1" };
    upgradeMocks.requestUpgradeSheet.mockReset();
    upgradeMocks.requestUpgradeSheet.mockReturnValue(true);
  });

  afterEach(() => {
    if (originalShare) {
      Object.defineProperty(navigator, "share", originalShare);
    } else {
      delete (navigator as { share?: unknown }).share;
    }

    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("explains Family and keeps an invite through sign-in for signed-out visitors", () => {
    authMocks.isAuthenticated = false;

    renderHouseholdPage("/household?invite=AbCdEfGh1234");

    expect(screen.getByRole("heading", { name: "How a household works" })).toBeVisible();
    expect(screen.getByText("Up to 6 people")).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in to join" })).toHaveAttribute(
      "href",
      "/account?invite=AbCdEfGh1234"
    );
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();
  });

  it("offers Family instead of a failed request when a non-Family account creates a household", async () => {
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };

    renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create household" }));

    expect(upgradeMocks.requestUpgradeSheet).toHaveBeenCalledWith("family_share_no_plan");
    expect(apiMocks.createHousehold).not.toHaveBeenCalled();
  });

  it("goes to Family pricing when the upgrade sheet was already shown", async () => {
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    upgradeMocks.requestUpgradeSheet.mockReturnValue(false);

    renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create household" }));

    expect(await screen.findByRole("heading", { name: "Pricing page" })).toBeVisible();
    expect(apiMocks.createHousehold).not.toHaveBeenCalled();
  });

  it("creates a household for Family accounts", async () => {
    apiMocks.createHousehold.mockResolvedValue({
      household: { ...household, activeMemberCount: 1, members: household.members.slice(0, 1) }
    });

    renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create household" }));

    expect(await screen.findByRole("heading", { name: "People" })).toBeVisible();
    expect(apiMocks.createHousehold).toHaveBeenCalled();
    expect(upgradeMocks.requestUpgradeSheet).not.toHaveBeenCalled();
  });

  it("checks invite codes before sending them and prefills codes from invite links", async () => {
    apiMocks.acceptHouseholdInvite.mockResolvedValue({
      household: { ...household, role: "member" }
    });

    renderHouseholdPage("/household?invite=abc");

    const field = await screen.findByRole("textbox", { name: "Invite code or link" });
    expect(field).toHaveValue("abc");

    fireEvent.click(screen.getByRole("button", { name: "Join household" }));
    expect(await screen.findByText(/That code looks too short/u)).toBeVisible();
    expect(screen.queryByText(/ZodError|too_small/u)).not.toBeInTheDocument();
    expect(apiMocks.acceptHouseholdInvite).not.toHaveBeenCalled();

    fireEvent.change(field, {
      target: { value: "https://linkdish.ca/invite/?code=AbCdEfGh1234" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Join household" }));

    await waitFor(() => {
      expect(apiMocks.acceptHouseholdInvite).toHaveBeenCalledWith({ inviteCode: "AbCdEfGh1234" });
    });
    expect(authMocks.refreshUser).toHaveBeenCalled();
    expect(await screen.findByText("Welcome to the household!")).toBeVisible();
  });

  it("shows the server's explanation when joining fails", async () => {
    apiMocks.acceptHouseholdInvite.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 403, {
        message: "This invite was sent to a different email address."
      })
    );

    renderHouseholdPage("/household?invite=AbCdEfGh1234");

    fireEvent.click(await screen.findByRole("button", { name: "Join household" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invite was sent to a different email address."
    );
    expect(screen.queryByText("Extractor API request failed.")).not.toBeInTheDocument();
  });

  it("lists members with owner and you badges, and confirms before removing one", async () => {
    apiMocks.getHousehold.mockResolvedValue({ household });
    apiMocks.removeHouseholdMember.mockReturnValue(new Promise(() => undefined));

    renderHouseholdPage();

    expect(await screen.findByText("Ana Lopez")).toBeVisible();
    expect(screen.getByText("Owner")).toBeVisible();
    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText("3 of 6 spots used")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Leave household" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Ana Lopez" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Ana Lopez?" });
    expect(apiMocks.removeHouseholdMember).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(apiMocks.removeHouseholdMember).toHaveBeenCalledWith({ userId: "user_2" });
    });
    // Only the member being removed shows a spinner.
    expect(screen.getByRole("button", { name: "Remove Ana Lopez" })).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(screen.getByRole("button", { name: "Remove jo" })).not.toHaveAttribute("aria-busy");
  });

  it("asks members to confirm before leaving", async () => {
    authMocks.user = { billingPlan: "family", email: "ana@example.com", id: "user_2" };
    apiMocks.getHousehold.mockResolvedValue({ household: { ...household, role: "member" } });
    let sentFor: string | null | undefined;
    apiMocks.leaveHousehold.mockImplementation(() => {
      sentFor = getRequestBinding()?.account;
      return Promise.resolve({ household: null });
    });

    renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Leave household" }));
    const dialog = screen.getByRole("dialog", { name: "Leave cook's household?" });
    expect(apiMocks.leaveHousehold).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Remove/u })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Leave household" }));

    await waitFor(() => expect(apiMocks.leaveHousehold).toHaveBeenCalled());
    // Sent only as this account, never as one Clerk switches to before it goes out.
    expect(sentFor).toBe("user_2");
    expect(authMocks.refreshUser).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "How a household works" })).toBeVisible();
  });

  it("shares a new invite with a web join link, copying when there's no share sheet", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    delete (navigator as { share?: unknown }).share;

    apiMocks.getHousehold.mockResolvedValue({ household });
    apiMocks.createHouseholdInvite.mockResolvedValue({
      household: {
        ...household,
        invites: [
          { email: "guest@example.com", expiresAt: "2099-01-01T00:00:00.000Z", id: "inv_1" }
        ]
      },
      invite: {
        email: "guest@example.com",
        expiresAt: "2099-01-01T00:00:00.000Z",
        id: "inv_1",
        inviteCode: "AbCdEfGh1234",
        inviteUrl: "https://linkdish.ca/invite/?code=AbCdEfGh1234"
      }
    });

    const view = renderHouseholdPage();

    const email = await screen.findByRole("textbox", { name: "Their email" });
    fireEvent.change(email, { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText("Enter the email address they use for LinkDish.")).toBeVisible();
    expect(apiMocks.createHouseholdInvite).not.toHaveBeenCalled();

    fireEvent.change(email, { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    const link = await screen.findByRole("link", {
      name: "app.linkdish.ca/household?invite=AbCdEfGh1234"
    });
    expect(link).toHaveAttribute("href", "https://app.linkdish.ca/household?invite=AbCdEfGh1234");
    expect(screen.getByText("AbCdEfGh1234")).toBeVisible();

    fireEvent.click(screen.getAllByRole("button", { name: "Copy link" })[0]!);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "https://app.linkdish.ca/household?invite=AbCdEfGh1234"
      );
    });
    expect(await screen.findByText("Invite link copied")).toBeVisible();

    // Later visits on this device can still share the pending invite.
    view.unmount();
    apiMocks.getHousehold.mockResolvedValue({
      household: {
        ...household,
        invites: [
          { email: "guest@example.com", expiresAt: "2099-01-01T00:00:00.000Z", id: "inv_1" }
        ]
      }
    });
    renderHouseholdPage();
    expect(
      await screen.findByRole("button", { name: "Copy invite link for guest@example.com" })
    ).toBeVisible();
  });

  it("uses the system share sheet when there is one", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    localStorage.setItem(
      "linkdish:web:household-invite-links:v1",
      JSON.stringify({
        inv_1: {
          code: "AbCdEfGh1234",
          email: "guest@example.com",
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      })
    );
    apiMocks.getHousehold.mockResolvedValue({
      household: {
        ...household,
        invites: [
          { email: "guest@example.com", expiresAt: "2099-01-01T00:00:00.000Z", id: "inv_1" }
        ]
      }
    });

    renderHouseholdPage();

    const shareButton = await screen.findByRole("button", {
      name: "Share invite for guest@example.com"
    });
    await act(async () => {
      fireEvent.click(shareButton);
      await Promise.resolve();
    });

    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://app.linkdish.ca/household?invite=AbCdEfGh1234" })
    );
  });

  it("confirms invite cancellation in an app-native dialog", async () => {
    const householdWithInvite: HouseholdDetails = {
      ...household,
      invites: [
        {
          email: "guest@example.com",
          expiresAt: "2099-08-01T00:00:00.000Z",
          id: "invite_1"
        }
      ]
    };
    apiMocks.getHousehold.mockResolvedValue({ household: householdWithInvite });
    apiMocks.cancelHouseholdInvite.mockResolvedValue({ household });

    renderHouseholdPage();

    expect(await screen.findByText("guest@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite for guest@example.com" }));

    const firstDialog = screen.getByRole("dialog", { name: "Cancel invite?" });
    expect(firstDialog).toHaveTextContent(
      "This stops guest@example.com from joining with this invite."
    );
    expect(apiMocks.cancelHouseholdInvite).not.toHaveBeenCalled();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Keep invite" }));
    expect(screen.queryByRole("dialog", { name: "Cancel invite?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel invite for guest@example.com" }));
    const confirmation = screen.getByRole("dialog", { name: "Cancel invite?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel invite" }));

    await waitFor(() => {
      expect(apiMocks.cancelHouseholdInvite).toHaveBeenCalledWith({ inviteId: "invite_1" });
      expect(screen.queryByText("guest@example.com")).not.toBeInTheDocument();
    });
  });

  it("does not render the old shopping-list card", async () => {
    apiMocks.getHousehold.mockResolvedValue({ household });

    renderHouseholdPage();

    expect(await screen.findByRole("heading", { name: "People" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Shopping list" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Household shopping list/u })).toHaveAttribute(
      "href",
      "/shopping"
    );
  });
});

describe("HouseholdPage account switches", () => {
  const otherAccount = { billingPlan: "free" as const, email: "bo@example.com", id: "user_9" };

  beforeEach(() => {
    localStorage.clear();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    authMocks.credentialsPending = false;
    authMocks.credentialsSource = "session";
    authMocks.isAuthenticated = true;
    authMocks.refreshUser.mockReset();
    authMocks.refreshUser.mockResolvedValue(undefined);
    authMocks.user = { billingPlan: "family", email: "cook@example.com", id: "user_1" };
    upgradeMocks.requestUpgradeSheet.mockReset();
    upgradeMocks.requestUpgradeSheet.mockReturnValue(true);
  });

  const expectNoTraceOfTheLastHousehold = () => {
    expect(screen.queryByText("Ana Lopez")).not.toBeInTheDocument();
    expect(screen.queryByText("ana@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "People" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invite someone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Ana Lopez" })).not.toBeInTheDocument();
  };

  it("never shows the last account's household while the next one's loads", async () => {
    const nextAnswer = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockResolvedValueOnce({ household });
    apiMocks.getHousehold.mockReturnValueOnce(nextAnswer.promise);

    const view = renderHouseholdPage();
    expect(await screen.findByText("Ana Lopez")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Invite someone" })).toBeVisible();

    // Clerk answers with a different account than the cached one.
    authMocks.user = otherAccount;
    view.rerender(householdTree());

    expectNoTraceOfTheLastHousehold();
    expect(screen.getByRole("status", { name: "Loading household" })).toBeVisible();

    await act(async () => {
      nextAnswer.resolve({ household: null });
      await nextAnswer.promise;
    });

    expect(await screen.findByRole("heading", { name: "How a household works" })).toBeVisible();
    expectNoTraceOfTheLastHousehold();
  });

  it("drops a late answer for the account that was signed in before", async () => {
    const lateAnswer = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockReturnValueOnce(lateAnswer.promise);
    apiMocks.getHousehold.mockResolvedValueOnce({ household: null });

    const view = renderHouseholdPage();
    expect(screen.getByRole("status", { name: "Loading household" })).toBeVisible();

    authMocks.user = otherAccount;
    view.rerender(householdTree());
    expect(await screen.findByRole("heading", { name: "How a household works" })).toBeVisible();

    await act(async () => {
      lateAnswer.resolve({ household });
      await lateAnswer.promise;
    });

    expect(screen.getByRole("heading", { name: "How a household works" })).toBeVisible();
    expectNoTraceOfTheLastHousehold();
  });

  it("keeps an answer that lands after signing out from the next account to sign in", async () => {
    const lateAnswer = deferred<{ household: HouseholdDetails | null }>();
    const nextAnswer = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockReturnValueOnce(lateAnswer.promise);
    apiMocks.getHousehold.mockReturnValueOnce(nextAnswer.promise);

    const view = renderHouseholdPage();

    authMocks.isAuthenticated = false;
    view.rerender(householdTree());
    expect(screen.getByRole("link", { name: "Sign in to get started" })).toBeVisible();

    await act(async () => {
      lateAnswer.resolve({ household });
      await lateAnswer.promise;
    });

    authMocks.isAuthenticated = true;
    authMocks.user = otherAccount;
    view.rerender(householdTree());

    expectNoTraceOfTheLastHousehold();
    expect(screen.getByRole("status", { name: "Loading household" })).toBeVisible();
    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2);
  });

  it("closes the last account's owner controls and drops what their actions answer", async () => {
    const removal = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockResolvedValueOnce({ household });
    apiMocks.getHousehold.mockResolvedValueOnce({ household: null });
    apiMocks.removeHouseholdMember.mockReturnValue(removal.promise);

    const view = renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Remove Ana Lopez" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Ana Lopez?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(apiMocks.removeHouseholdMember).toHaveBeenCalledWith({ userId: "user_2" });
    });

    authMocks.user = otherAccount;
    view.rerender(householdTree());

    expect(screen.queryByRole("dialog", { name: "Remove Ana Lopez?" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "How a household works" })).toBeVisible();

    await act(async () => {
      removal.resolve({
        household: { ...household, activeMemberCount: 2, members: household.members.slice(0, 1) }
      });
      await removal.promise;
    });

    expect(screen.queryByText("Ana Lopez was removed")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "How a household works" })).toBeVisible();
    expectNoTraceOfTheLastHousehold();
  });

  it("doesn't finish joining for an account that signed in since", async () => {
    const joining = deferred<{ household: HouseholdDetails | null }>();
    apiMocks.getHousehold.mockResolvedValue({ household: null });
    apiMocks.acceptHouseholdInvite.mockReturnValue(joining.promise);
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };

    const view = renderHouseholdPage("/household?invite=AbCdEfGh1234");

    fireEvent.click(await screen.findByRole("button", { name: "Join household" }));
    await waitFor(() => expect(apiMocks.acceptHouseholdInvite).toHaveBeenCalled());

    authMocks.user = otherAccount;
    view.rerender(householdTree("/household?invite=AbCdEfGh1234"));
    expect(
      await screen.findByRole("heading", { name: "Join the household you were invited to" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Join household" })).not.toHaveAttribute("aria-busy");

    await act(async () => {
      joining.resolve({ household: { ...household, role: "member" } });
      await joining.promise;
    });

    expect(authMocks.refreshUser).not.toHaveBeenCalled();
    expect(screen.queryByText("Welcome to the household!")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Join the household you were invited to" })
    ).toBeVisible();
    expectNoTraceOfTheLastHousehold();
  });

  it("waits for the account's credentials, then loads once they're ready", async () => {
    authMocks.credentialsPending = true;
    apiMocks.getHousehold.mockResolvedValue({ household });

    const view = renderHouseholdPage();

    expect(screen.getByRole("status", { name: "Loading household" })).toBeVisible();
    expect(apiMocks.getHousehold).not.toHaveBeenCalled();

    authMocks.credentialsPending = false;
    view.rerender(householdTree());

    expect(await screen.findByText("Ana Lopez")).toBeVisible();
    expect(apiMocks.getHousehold).toHaveBeenCalledTimes(1);
  });

  it("keeps a no-household account's page, and a typed invite code, while the same account asks again", async () => {
    const reload = deferred<{ household: HouseholdDetails | null }>();
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };
    apiMocks.getHousehold.mockResolvedValueOnce({ household: null });
    apiMocks.getHousehold.mockReturnValueOnce(reload.promise);

    const view = renderHouseholdPage();
    const field = await screen.findByRole("textbox", { name: "Invite code or link" });
    fireEvent.change(field, { target: { value: "AbCdEfGh1234" } });

    // Clerk finished signing the same account in late: ask again without blanking the page.
    authMocks.credentialsSource = "clerk";
    view.rerender(householdTree());
    await waitFor(() => expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole("status", { name: "Loading household" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Got an invite?" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Invite code or link" })).toHaveValue(
      "AbCdEfGh1234"
    );

    await act(async () => {
      reload.resolve({ household: null });
      await reload.promise;
    });

    expect(screen.getByRole("textbox", { name: "Invite code or link" })).toHaveValue(
      "AbCdEfGh1234"
    );
  });

  it("keeps what the same account's page shows when asking again fails", async () => {
    const reload = deferred<{ household: HouseholdDetails | null }>();
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };
    apiMocks.getHousehold.mockResolvedValueOnce({ household: null });
    apiMocks.getHousehold.mockReturnValueOnce(
      reload.promise.then(() => Promise.reject(new TypeError("Failed to fetch")))
    );

    const view = renderHouseholdPage();
    const field = await screen.findByRole("textbox", { name: "Invite code or link" });
    fireEvent.change(field, { target: { value: "AbCdEfGh1234" } });

    authMocks.credentialsSource = "clerk";
    view.rerender(householdTree());
    await waitFor(() => expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2));

    await act(async () => {
      reload.resolve({ household: null });
      await reload.promise.catch(() => undefined);
    });

    await waitFor(() => expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("We couldn't load your household")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Invite code or link" })).toHaveValue(
      "AbCdEfGh1234"
    );
  });

  it("asks again when the same account's credentials change, and lets a newer action win", async () => {
    const reload = deferred<{ household: HouseholdDetails | null }>();
    authMocks.user = { billingPlan: "family", email: "ana@example.com", id: "user_2" };
    apiMocks.getHousehold.mockResolvedValueOnce({ household: { ...household, role: "member" } });
    apiMocks.getHousehold.mockReturnValueOnce(reload.promise);
    apiMocks.leaveHousehold.mockResolvedValue({ household: null });

    const view = renderHouseholdPage();
    expect(await screen.findByText("Ana Lopez")).toBeVisible();

    // Clerk finished signing the same account in late: ask again, keeping what's shown meanwhile.
    authMocks.credentialsSource = "clerk";
    view.rerender(householdTree());
    await waitFor(() => expect(apiMocks.getHousehold).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Ana Lopez")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Leave household" }));
    const dialog = screen.getByRole("dialog", { name: "Leave cook's household?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave household" }));
    expect(await screen.findByRole("heading", { name: "How a household works" })).toBeVisible();

    // The reload sent before leaving answers last; leaving is newer.
    await act(async () => {
      reload.resolve({ household: { ...household, role: "member" } });
      await reload.promise;
    });

    expect(screen.getByRole("heading", { name: "How a household works" })).toBeVisible();
    expect(screen.queryByRole("status", { name: "Loading household" })).not.toBeInTheDocument();
    expect(screen.queryByText("Ana Lopez")).not.toBeInTheDocument();
  });
});
