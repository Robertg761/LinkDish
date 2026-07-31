import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HouseholdPage } from "./HouseholdPage";

import type { HouseholdDetails } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  cancelHouseholdInvite: vi.fn(),
  getHousehold: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    acceptHouseholdInvite: vi.fn(),
    cancelHouseholdInvite: apiMocks.cancelHouseholdInvite,
    createHousehold: vi.fn(),
    createHouseholdInvite: vi.fn(),
    getHousehold: apiMocks.getHousehold,
    leaveHousehold: vi.fn(),
    removeHouseholdMember: vi.fn()
  }
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    refreshUser: vi.fn(),
    user: {
      email: "cook@example.com",
      id: "user_1"
    }
  })
}));

const household: HouseholdDetails = {
  activeMemberCount: 1,
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
    }
  ],
  ownerFamilyEntitlementActive: true,
  ownerUserId: "user_1",
  role: "owner"
};

const renderHouseholdPage = () =>
  render(
    <MemoryRouter>
      <HouseholdPage />
    </MemoryRouter>
  );

describe("HouseholdPage", () => {
  beforeEach(() => {
    apiMocks.cancelHouseholdInvite.mockReset();
    apiMocks.getHousehold.mockReset();
  });

  it.each([
    ["active household", household],
    ["no household", null]
  ])("does not render the old shopping-list card for %s", async (_label, nextHousehold) => {
    apiMocks.getHousehold.mockResolvedValue({
      household: nextHousehold
    });

    renderHouseholdPage();

    await waitFor(() => {
      expect(screen.queryByText("Loading household...")).not.toBeInTheDocument();
    });

    expect(screen.queryByRole("heading", { name: "Shopping list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open shopping list/u })).not.toBeInTheDocument();
  });

  it("confirms invite cancellation in an app-native dialog", async () => {
    const householdWithInvite: HouseholdDetails = {
      ...household,
      invites: [
        {
          email: "guest@example.com",
          expiresAt: "2026-08-01T00:00:00.000Z",
          id: "invite_1"
        }
      ]
    };
    apiMocks.getHousehold.mockResolvedValue({ household: householdWithInvite });
    apiMocks.cancelHouseholdInvite.mockResolvedValue({ household });

    renderHouseholdPage();

    expect(await screen.findByText("guest@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const firstDialog = screen.getByRole("dialog", { name: "Cancel invite?" });
    expect(firstDialog).toHaveTextContent(
      "This stops guest@example.com from joining with this invite."
    );
    expect(apiMocks.cancelHouseholdInvite).not.toHaveBeenCalled();
    fireEvent.click(within(firstDialog).getByRole("button", { name: "Keep invite" }));
    expect(screen.queryByRole("dialog", { name: "Cancel invite?" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const confirmation = screen.getByRole("dialog", { name: "Cancel invite?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel invite" }));

    await waitFor(() => {
      expect(apiMocks.cancelHouseholdInvite).toHaveBeenCalledWith({ inviteId: "invite_1" });
      expect(screen.queryByText("guest@example.com")).not.toBeInTheDocument();
    });
  });
});
