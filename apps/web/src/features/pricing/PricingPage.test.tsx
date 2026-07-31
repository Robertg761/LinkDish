import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PricingPage } from "./PricingPage";

const apiClientMocks = vi.hoisted(() => ({
  createWebBillingCheckout: vi.fn(),
  createWebBillingPortal: vi.fn(),
  getHousehold: vi.fn(),
  getWebBillingAvailability: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    createWebBillingCheckout: apiClientMocks.createWebBillingCheckout,
    createWebBillingPortal: apiClientMocks.createWebBillingPortal,
    getHousehold: apiClientMocks.getHousehold,
    getWebBillingAvailability: apiClientMocks.getWebBillingAvailability
  }
}));

vi.mock("../../analytics/client", () => ({
  trackWebV2AnalyticsEvent: vi.fn()
}));

const authMocks = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  refreshUser: vi.fn(),
  user: {
    billingPlan: "free",
    email: "family@example.com",
    id: "user_family"
  } as {
    billingPlan?: "free" | "plus" | "family";
    email: string;
    id: string;
    quota?: {
      meteringMode: "free_monthly_grandfathered";
      limit: number;
      monthlyLimit: number;
      remaining: number;
      remainingThisMonth: number;
      resetsAt: string;
    };
  } | null
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: Boolean(authMocks.user),
    loginWithGoogle: authMocks.loginWithGoogle,
    refreshUser: authMocks.refreshUser,
    user: authMocks.user
  })
}));

describe("PricingPage", () => {
  beforeEach(() => {
    authMocks.loginWithGoogle.mockReset();
    authMocks.refreshUser.mockReset();
    authMocks.user = {
      billingPlan: "free",
      email: "family@example.com",
      id: "user_family"
    };
    apiClientMocks.createWebBillingCheckout.mockReset();
    apiClientMocks.createWebBillingCheckout.mockResolvedValue({
      url: "https://pay.rev.cat/test/user_family?email=family%40example.com"
    });
    apiClientMocks.createWebBillingPortal.mockReset();
    apiClientMocks.getHousehold.mockReset();
    apiClientMocks.getHousehold.mockResolvedValue({
      household: {
        activeMemberCount: 2,
        cooldownSlotCount: 0,
        id: "household_1",
        invites: [],
        memberLimit: 6,
        members: [],
        ownerFamilyEntitlementActive: true,
        ownerUserId: "user_owner",
        role: "member"
      }
    });
    apiClientMocks.getWebBillingAvailability.mockReset();
    apiClientMocks.getWebBillingAvailability.mockResolvedValue({
      managementPortalAvailable: false,
      plans: {
        family: {
          monthly: true,
          yearly: true
        },
        plus: {
          monthly: true,
          yearly: true
        }
      },
      prices: {
        family: {
          monthly: "$4.99/month",
          yearly: "$44.99/year"
        },
        plus: {
          monthly: "$2.99/month",
          yearly: "$24.99/year"
        }
      },
      webCheckoutEnabled: true
    });
  });

  it("uses active Family household access as the current plan", async () => {
    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Family Household")).toBeInTheDocument();
    });

    const usageSummary = screen.getByText("This Month").closest(".usage-summary-card");
    expect(usageSummary).not.toBeNull();
    expect(within(usageSummary as HTMLElement).getByText("Family")).toBeInTheDocument();
    expect(within(usageSummary as HTMLElement).getByText("250 monthly limit")).toBeInTheDocument();
    expect(
      screen.getByText("Signed-in usage is checked by the LinkDish API when you import a recipe.")
    ).toBeInTheDocument();

    const activePlanButtons = screen.getAllByRole("button", { name: "Active Plan" });
    expect(activePlanButtons).toHaveLength(1);
    expect(activePlanButtons[0]?.closest(".pricing-card")).toHaveTextContent("Family");
    expect(screen.queryByText("Current Tier")).not.toBeInTheDocument();
    expect(screen.queryByText("Offline reading mode")).not.toBeInTheDocument();
    expect(screen.getAllByText("Saved recipes available offline")).toHaveLength(2);
  });

  it("starts RevenueCat web checkout for signed-in free users", async () => {
    apiClientMocks.getHousehold.mockResolvedValue({
      household: null
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        assign
      }
    });

    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    const plusCard = screen.getByText("Plus").closest(".pricing-card");
    expect(plusCard).not.toBeNull();

    await waitFor(() => {
      expect(
        within(plusCard as HTMLElement).getByRole("button", { name: "Yearly - $24.99/year" })
      ).toBeInTheDocument();
    });

    fireEvent.click(
      within(plusCard as HTMLElement).getByRole("button", { name: "Yearly - $24.99/year" })
    );

    await waitFor(() => {
      expect(apiClientMocks.createWebBillingCheckout).toHaveBeenCalledWith({
        period: "yearly",
        plan: "plus"
      });
    });
    expect(assign).toHaveBeenCalledWith(
      "https://pay.rev.cat/test/user_family?email=family%40example.com"
    );
  });

  it("navigates signed-out users to account sign-in from upgrade CTAs", async () => {
    authMocks.user = null;

    render(
      <MemoryRouter initialEntries={["/pricing"]}>
        <Routes>
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/account" element={<h1>Account sign-in</h1>} />
        </Routes>
      </MemoryRouter>
    );

    const plusCard = screen.getByText("Plus").closest(".pricing-card");
    expect(plusCard).not.toBeNull();

    const signInLink = within(plusCard as HTMLElement).getByRole("link", {
      name: "Sign in to upgrade"
    });
    expect(signInLink).toHaveAttribute("href", "/account?upgrade=plus");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    const freeCard = screen.getByRole("heading", { name: "Free" }).closest(".pricing-card");
    expect(freeCard).not.toBeNull();
    expect(freeCard as HTMLElement).toHaveTextContent("15 saved recipes free");
    expect(
      screen.queryByText("Signed-in usage is checked by the LinkDish API when you import a recipe.")
    ).not.toBeInTheDocument();

    fireEvent.click(signInLink);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Account sign-in" })).toBeInTheDocument();
    });
    expect(authMocks.loginWithGoogle).not.toHaveBeenCalled();
    expect(apiClientMocks.createWebBillingCheckout).not.toHaveBeenCalled();
  });

  it("shows the founding offer for signed-in free users when it is available", async () => {
    apiClientMocks.getHousehold.mockResolvedValue({ household: null });
    apiClientMocks.getWebBillingAvailability.mockResolvedValue({
      founding: {
        available: true,
        priceLabel: "$29.99"
      },
      managementPortalAvailable: false,
      plans: {
        family: { monthly: true, yearly: true },
        plus: { monthly: true, yearly: true }
      },
      prices: {
        family: { monthly: "$4.99/month", yearly: "$44.99/year" },
        plus: { monthly: "$2.99/month", yearly: "$24.99/year" }
      },
      webCheckoutEnabled: true
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, pathname: "/pricing" }
    });

    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Founding Plus")).toBeInTheDocument();
    });
    const foundingCard = screen.getByText("Founding Plus").closest(".founding-offer-card");
    expect(foundingCard).not.toBeNull();
    expect(within(foundingCard as HTMLElement).getByText("$29.99")).toBeInTheDocument();

    const claimButton = within(foundingCard as HTMLElement).getByRole("button", {
      name: "Become a founding member"
    });
    fireEvent.click(claimButton);

    await waitFor(() => {
      expect(apiClientMocks.createWebBillingCheckout).toHaveBeenCalledWith({ offer: "founding" });
    });
    expect(assign).toHaveBeenCalledWith(
      "https://pay.rev.cat/test/user_family?email=family%40example.com"
    );
  });

  it("hides the founding offer when it is unavailable", async () => {
    apiClientMocks.getHousehold.mockResolvedValue({ household: null });

    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Plus").closest(".pricing-card")).not.toBeNull();
    });
    expect(screen.queryByText("Founding Plus")).not.toBeInTheDocument();
  });

  it("does not pitch the founding offer to family members", async () => {
    apiClientMocks.getWebBillingAvailability.mockResolvedValue({
      founding: {
        available: true,
        priceLabel: "$29.99"
      },
      managementPortalAvailable: false,
      plans: {
        family: { monthly: true, yearly: true },
        plus: { monthly: true, yearly: true }
      },
      prices: {
        family: { monthly: "$4.99/month", yearly: "$44.99/year" },
        plus: { monthly: "$2.99/month", yearly: "$24.99/year" }
      },
      webCheckoutEnabled: true
    });

    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Family Household")).toBeInTheDocument();
    });
    expect(screen.queryByText("Founding Plus")).not.toBeInTheDocument();
  });

  it("prefers monthly quota fields in the usage card when present", async () => {
    authMocks.user = {
      billingPlan: "free",
      email: "family@example.com",
      id: "user_family",
      quota: {
        limit: 5,
        meteringMode: "free_monthly_grandfathered",
        monthlyLimit: 5,
        remaining: 1,
        remainingThisMonth: 1,
        resetsAt: "2026-08-01T00:00:00.000Z"
      }
    };
    apiClientMocks.getHousehold.mockResolvedValue({
      household: null
    });

    render(
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    );

    const usageSummary = screen.getByText("Free Usage").closest(".usage-summary-card");
    expect(usageSummary).not.toBeNull();

    await waitFor(() => {
      expect(
        within(usageSummary as HTMLElement).getByText(/^1 of 5 left this month/u)
      ).toBeInTheDocument();
    });
  });
});
