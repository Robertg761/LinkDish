import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { resetWebBillingAvailabilityForTests } from "../billing/billing-availability";
import {
  CHECKOUT_SESSION_STORAGE_KEY,
  rememberPendingCheckout,
  resetCheckoutSessionForTests
} from "../billing/checkout-session";

import { PricingPage } from "./PricingPage";

import type { HouseholdDetails, WebBillingAvailability } from "@linkdish/api-contracts";

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

const analyticsMocks = vi.hoisted(() => ({
  trackWebV2AnalyticsEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebV2AnalyticsEvent: analyticsMocks.trackWebV2AnalyticsEvent
}));

type MockUser = {
  billingPlan?: "free" | "plus" | "family";
  email: string;
  id: string;
} | null;

const authMocks = vi.hoisted(() => ({
  loginWithGoogle: vi.fn(),
  refreshUser: vi.fn(),
  user: null as MockUser
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: Boolean(authMocks.user),
    loginWithGoogle: authMocks.loginWithGoogle,
    refreshUser: authMocks.refreshUser,
    user: authMocks.user
  })
}));

const availability = (overrides: Partial<WebBillingAvailability> = {}): WebBillingAvailability => ({
  managementPortalAvailable: false,
  plans: {
    family: { monthly: true, yearly: true },
    plus: { monthly: true, yearly: true }
  },
  prices: {
    family: { monthly: "$4.99/month", yearly: "$44.99/year" },
    plus: { monthly: "$2.99/month", yearly: "$24.99/year" }
  },
  webCheckoutEnabled: true,
  ...overrides
});

const memberHousehold: HouseholdDetails = {
  activeMemberCount: 2,
  cooldownSlotCount: 0,
  id: "household_1",
  invites: [],
  memberLimit: 6,
  members: [
    {
      displayName: "Sam",
      email: "sam@example.com",
      joinedAt: "2026-07-01T00:00:00.000Z",
      role: "owner",
      userId: "user_owner"
    },
    {
      email: "family@example.com",
      joinedAt: "2026-07-02T00:00:00.000Z",
      role: "member",
      userId: "user_family"
    }
  ],
  ownerFamilyEntitlementActive: true,
  ownerUserId: "user_owner",
  role: "member"
};

const planCard = (name: string) => {
  const card = screen.getByRole("article", { name });
  return within(card);
};

const renderPricing = (entry = "/pricing") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/account" element={<h1>Account sign-in</h1>} />
      </Routes>
    </MemoryRouter>
  );

const assign = vi.fn();

/** Waits until availability has loaded and the Plus button is ready to use. */
const waitForCheckoutReady = () =>
  waitFor(() => {
    expect(planCard("Plus").getByRole("button", { name: "Upgrade to Plus" })).toBeEnabled();
  });

describe("PricingPage", () => {
  beforeEach(() => {
    resetWebBillingAvailabilityForTests();
    resetCheckoutSessionForTests();
    sessionStorage.clear();
    analyticsMocks.trackWebV2AnalyticsEvent.mockReset();
    authMocks.loginWithGoogle.mockReset();
    authMocks.refreshUser.mockReset();
    authMocks.refreshUser.mockResolvedValue(undefined);
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
    apiClientMocks.createWebBillingPortal.mockResolvedValue({
      url: "https://billing.stripe.com/p/session/test"
    });
    apiClientMocks.getHousehold.mockReset();
    apiClientMocks.getHousehold.mockResolvedValue({ household: null });
    apiClientMocks.getWebBillingAvailability.mockReset();
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(availability());
    assign.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, pathname: "/pricing" }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leads with value and never shows internal billing copy", async () => {
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(
      availability({
        plans: {
          family: { monthly: false, yearly: false },
          plus: { monthly: false, yearly: false }
        },
        webCheckoutEnabled: false
      })
    );

    renderPricing();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cook more, juggle less.");
    await waitFor(() => {
      expect(planCard("Plus").getByText(/Online checkout is taking a short break/u)).toBeVisible();
    });
    expect(planCard("Plus").getByRole("link", { name: "support@linkdish.ca" })).toBeVisible();
    expect(screen.queryByText(/Setup Needed/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/RevenueCat/iu)).not.toBeInTheDocument();
    expect(analyticsMocks.trackWebV2AnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "upgrade_viewed", properties: { trigger: "pricing" } })
    );
  });

  it("recommends Plus, shows yearly prices with honest savings and switches to monthly", async () => {
    renderPricing();
    await waitForCheckoutReady();

    const plus = planCard("Plus");
    expect(plus.getByText("Recommended")).toBeVisible();
    expect(plus.getByText("$24.99")).toBeVisible();
    expect(plus.getByText("$2.08 a month, billed yearly")).toBeVisible();
    expect(plus.getByText("Save 30%")).toBeVisible();
    expect(planCard("Family").getByText("Save 24%")).toBeVisible();
    expect(screen.getByText("Yearly saves up to 30%")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));

    expect(plus.getByText("$2.99")).toBeVisible();
    expect(plus.queryByText(/Save \d+%/u)).not.toBeInTheDocument();
    expect(planCard("Free").getByText("Current plan")).toBeVisible();
  });

  it("starts web checkout for the chosen plan and period and remembers it", async () => {
    renderPricing();

    fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
    const upgrade = await planCard("Family").findByRole("button", { name: "Upgrade to Family" });
    await waitFor(() => expect(upgrade).toBeEnabled());
    fireEvent.click(upgrade);

    await waitFor(() => {
      expect(apiClientMocks.createWebBillingCheckout).toHaveBeenCalledWith({
        period: "monthly",
        plan: "family"
      });
    });
    expect(assign).toHaveBeenCalledWith(
      "https://pay.rev.cat/test/user_family?email=family%40example.com"
    );
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_SESSION_STORAGE_KEY) ?? "{}")).toMatchObject({
      period: "monthly",
      plan: "family",
      status: "pending",
      trigger: "pricing"
    });
  });

  it("shows a friendly message when checkout can't start", async () => {
    apiClientMocks.createWebBillingCheckout.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 503, {
        message: "Web checkout is not enabled yet."
      })
    );

    renderPricing();

    const upgrade = await planCard("Plus").findByRole("button", { name: "Upgrade to Plus" });
    await waitFor(() => expect(upgrade).toBeEnabled());
    fireEvent.click(upgrade);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Online checkout isn't available right now.");
    expect(alert).not.toHaveTextContent("Extractor API");
    expect(sessionStorage.getItem(CHECKOUT_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("sends signed-out visitors to sign in with their plan choice", async () => {
    authMocks.user = null;

    renderPricing();

    const signInLink = planCard("Plus").getByRole("link", { name: "Sign in to upgrade" });
    expect(signInLink).toHaveAttribute("href", "/account?upgrade=plus");
    expect(planCard("Free").getByText("3 of 3")).toBeVisible();
    expect(planCard("Free").getByRole("progressbar", { name: "Free imports left" })).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Monthly" }));
    expect(planCard("Family").getByRole("link", { name: "Sign in to upgrade" })).toHaveAttribute(
      "href",
      "/account?upgrade=family&period=monthly"
    );

    fireEvent.click(signInLink);
    expect(await screen.findByRole("heading", { name: "Account sign-in" })).toBeVisible();
    expect(apiClientMocks.createWebBillingCheckout).not.toHaveBeenCalled();
  });

  it("highlights and scrolls to the plan asked for in ?upgrade=", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderPricing("/pricing?upgrade=family&period=monthly");

    const family = screen.getByRole("article", { name: "Family" });
    expect(family).toHaveClass("is-selected");
    expect(screen.getByRole("article", { name: "Plus" })).not.toHaveClass("is-selected");
    expect(screen.getByRole("radio", { name: "Monthly" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toBe(family);
    expect(await within(family).findByRole("button", { name: "Upgrade to Family" })).toHaveClass(
      "btn-primary"
    );
  });

  it("treats Family from someone else's household as shared, with no billing to manage", async () => {
    apiClientMocks.getHousehold.mockResolvedValue({ household: memberHousehold });
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(
      availability({
        founding: { available: true, priceLabel: "$29.99" },
        managementPortalAvailable: true
      })
    );

    renderPricing();

    expect(await planCard("Family").findByText("Shared with you by Sam")).toBeVisible();
    expect(planCard("Family").getByText("Current plan")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage billing" })).not.toBeInTheDocument();
    expect(planCard("Plus").getByText("Included in Family")).toBeVisible();
    expect(screen.queryByText("Founding Plus")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage household" })).toHaveAttribute(
      "href",
      "/household"
    );
  });

  it("lets a Family owner manage their own billing", async () => {
    authMocks.user = { billingPlan: "family", email: "sam@example.com", id: "user_owner" };
    apiClientMocks.getHousehold.mockResolvedValue({
      household: { ...memberHousehold, role: "owner" }
    });
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(
      availability({ managementPortalAvailable: true })
    );

    renderPricing();

    const manage = await planCard("Family").findByRole("button", { name: "Manage billing" });
    fireEvent.click(manage);

    await waitFor(() => {
      expect(apiClientMocks.createWebBillingPortal).toHaveBeenCalled();
    });
    expect(assign).toHaveBeenCalledWith("https://billing.stripe.com/p/session/test");
  });

  it("uses neutral copy when it can't tell who pays for Family", async () => {
    authMocks.user = { billingPlan: "family", email: "sam@example.com", id: "user_owner" };
    apiClientMocks.getHousehold.mockRejectedValue(new TypeError("Failed to fetch"));
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(
      availability({ managementPortalAvailable: true })
    );

    renderPricing();

    expect(
      await planCard("Family").findByText(
        "Billing is managed by the account that started this plan."
      )
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage billing" })).not.toBeInTheDocument();
  });

  it("offers the founding deal to free accounts only when it is available", async () => {
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(
      availability({ founding: { available: true, priceLabel: "$29.99" } })
    );

    renderPricing();

    const founding = within(await screen.findByRole("region", { name: "Founding Plus" }));
    expect(founding.getByText("$29.99")).toBeVisible();
    fireEvent.click(founding.getByRole("button", { name: "Become a founding member" }));

    await waitFor(() => {
      expect(apiClientMocks.createWebBillingCheckout).toHaveBeenCalledWith({ offer: "founding" });
    });
    expect(assign).toHaveBeenCalled();
  });

  it("hides the founding offer when it is unavailable", async () => {
    renderPricing();

    await waitFor(() => {
      expect(apiClientMocks.getWebBillingAvailability).toHaveBeenCalled();
    });
    expect(screen.queryByText("Founding Plus")).not.toBeInTheDocument();
  });

  it("answers the common questions", async () => {
    renderPricing();
    await waitForCheckoutReady();

    expect(screen.getByText("What counts as an import?")).toBeVisible();
    expect(screen.getByText("What happens to my recipes if I cancel?")).toBeVisible();
    expect(screen.getByText("Can I share with family?")).toBeVisible();
    expect(screen.getByRole("table")).toHaveTextContent("Household shopping list");
  });
});

describe("PricingPage checkout return", () => {
  beforeEach(() => {
    resetWebBillingAvailabilityForTests();
    resetCheckoutSessionForTests();
    sessionStorage.clear();
    analyticsMocks.trackWebV2AnalyticsEvent.mockReset();
    authMocks.refreshUser.mockReset();
    authMocks.refreshUser.mockResolvedValue(undefined);
    authMocks.user = { billingPlan: "free", email: "cook@example.com", id: "user_1" };
    apiClientMocks.getHousehold.mockReset();
    apiClientMocks.getHousehold.mockResolvedValue({ household: null });
    apiClientMocks.getWebBillingAvailability.mockReset();
    apiClientMocks.getWebBillingAvailability.mockResolvedValue(availability());
  });

  const purchaseEvents = () =>
    analyticsMocks.trackWebV2AnalyticsEvent.mock.calls.filter(
      ([event]) => (event as { name: string }).name === "upgrade_purchased"
    );

  it("reports the purchase once per checkout and celebrates when the plan arrives", async () => {
    rememberPendingCheckout({ period: "yearly", plan: "plus", trigger: "pricing" });

    const first = renderPricing("/pricing?checkout=success");

    expect(await screen.findByText("Payment received")).toBeVisible();
    await waitFor(() => expect(authMocks.refreshUser).toHaveBeenCalled());
    expect(purchaseEvents()).toHaveLength(1);
    expect(purchaseEvents()[0]?.[0]).toMatchObject({
      properties: { billing_period: "yearly", plan: "plus", trigger: "pricing" }
    });

    // The API catches up: the account is now on Plus.
    authMocks.user = { billingPlan: "plus", email: "cook@example.com", id: "user_1" };
    first.unmount();

    // A reload of the same success page shows the celebration but never counts the purchase again.
    renderPricing("/pricing?checkout=success");
    expect(await screen.findByRole("heading", { name: "Welcome to Plus!" })).toBeVisible();
    expect(purchaseEvents()).toHaveLength(1);
    expect(planCard("Plus").getByText("Current plan")).toBeVisible();
  });

  it("keeps asking for the new plan, then explains a delay honestly", async () => {
    vi.useFakeTimers();

    renderPricing("/pricing?checkout=success");

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(authMocks.refreshUser.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(
      screen.getByRole("heading", { name: "Thanks, your payment went through" })
    ).toBeVisible();
    expect(purchaseEvents()).toHaveLength(1);
    expect(purchaseEvents()[0]?.[0]).toMatchObject({
      properties: { plan: "unknown", trigger: "pricing" }
    });

    vi.useRealTimers();
  });

  it("confirms a cancelled checkout without reporting a purchase", async () => {
    renderPricing("/pricing?checkout=cancelled");
    await waitForCheckoutReady();

    expect(screen.getByRole("heading", { name: "Checkout cancelled" })).toBeVisible();
    expect(purchaseEvents()).toHaveLength(0);
  });
});
