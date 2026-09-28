import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
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

const renderHouseholdPage = (entry = "/household") =>
  render(
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
    apiMocks.leaveHousehold.mockResolvedValue({ household: null });

    renderHouseholdPage();

    fireEvent.click(await screen.findByRole("button", { name: "Leave household" }));
    const dialog = screen.getByRole("dialog", { name: "Leave cook's household?" });
    expect(apiMocks.leaveHousehold).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Remove/u })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Leave household" }));

    await waitFor(() => expect(apiMocks.leaveHousehold).toHaveBeenCalled());
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
