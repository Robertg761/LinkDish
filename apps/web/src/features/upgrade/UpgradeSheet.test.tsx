import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetWebBillingAvailabilityForTests } from "../billing/billing-availability";
import {
  CHECKOUT_SESSION_STORAGE_KEY,
  resetCheckoutSessionForTests
} from "../billing/checkout-session";

import { UpgradeSheetProvider, useUpgradeSheet } from "./UpgradeSheet";

import type { UpgradeSheetTrigger } from "./UpgradeSheet";

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn(),
  trackWebV2AnalyticsEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent,
  trackWebV2AnalyticsEvent: analyticsMocks.trackWebV2AnalyticsEvent
}));

const apiMocks = vi.hoisted(() => ({
  createWebBillingCheckout: vi.fn(),
  getWebBillingAvailability: vi.fn()
}));

vi.mock("../../api/client", () => ({
  apiClient: {
    createWebBillingCheckout: apiMocks.createWebBillingCheckout,
    getWebBillingAvailability: apiMocks.getWebBillingAvailability
  }
}));

const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  plan: "free" as "free" | "plus" | "family"
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    refreshUser: vi.fn(),
    user: authState.isAuthenticated
      ? { billingPlan: authState.plan, email: "cook@example.com", id: "user_1" }
      : null
  })
}));

const TriggerButtons = () => {
  const { requestUpgradeSheet } = useUpgradeSheet();
  const triggers: UpgradeSheetTrigger[] = ["save_limit", "import_limit", "family_share_no_plan"];

  return (
    <>
      {triggers.map((trigger) => (
        <button key={trigger} onClick={() => requestUpgradeSheet(trigger)} type="button">
          {trigger}
        </button>
      ))}
    </>
  );
};

const renderUpgradeHarness = () =>
  render(
    <MemoryRouter>
      <UpgradeSheetProvider>
        <TriggerButtons />
      </UpgradeSheetProvider>
    </MemoryRouter>
  );

const assign = vi.fn();

describe("UpgradeSheetProvider", () => {
  beforeEach(() => {
    analyticsMocks.trackWebEvent.mockReset();
    analyticsMocks.trackWebV2AnalyticsEvent.mockReset();
    apiMocks.createWebBillingCheckout.mockReset();
    apiMocks.createWebBillingCheckout.mockResolvedValue({ url: "https://pay.rev.cat/test" });
    apiMocks.getWebBillingAvailability.mockReset();
    apiMocks.getWebBillingAvailability.mockResolvedValue({
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
    authState.isAuthenticated = true;
    authState.plan = "free";
    resetWebBillingAvailabilityForTests();
    resetCheckoutSessionForTests();
    sessionStorage.clear();
    assign.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, pathname: "/" }
    });
  });

  it("shows a sheet once per trigger per session and never stacks sheets", async () => {
    renderUpgradeHarness();

    fireEvent.click(screen.getByRole("button", { name: "save_limit" }));

    const dialog = await screen.findByRole("dialog", { name: "Your free cookbook is full." });
    expect(dialog).toHaveTextContent(/You have 15 recipes saved on Free/u);
    expect(within(dialog).getByText("Unlimited saved recipes")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "upgrade_viewed",
        properties: {
          trigger: "save_limit"
        }
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "import_limit" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "save_limit" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "import_limit" }));
    expect(
      await screen.findByRole("dialog", { name: "More room for the recipes worth keeping." })
    ).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("preselects yearly and the plan that fits the trigger, then checks out from the sheet", async () => {
    renderUpgradeHarness();

    fireEvent.click(screen.getByRole("button", { name: "family_share_no_plan" }));
    const dialog = await screen.findByRole("dialog", { name: "Share the kitchen with Family." });

    expect(within(dialog).getByRole("radio", { name: "Yearly" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(within(dialog).getByRole("radio", { name: "Family, $44.99/year" })).toBeChecked();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Monthly" }));
    expect(within(dialog).getByRole("radio", { name: "Family, $4.99/month" })).toBeChecked();

    const upgrade = within(dialog).getByRole("button", { name: "Upgrade to Family" });
    await waitFor(() => expect(upgrade).toBeEnabled());
    fireEvent.click(upgrade);

    await waitFor(() => {
      expect(apiMocks.createWebBillingCheckout).toHaveBeenCalledWith({
        period: "monthly",
        plan: "family"
      });
    });
    expect(assign).toHaveBeenCalledWith("https://pay.rev.cat/test");
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_SESSION_STORAGE_KEY) ?? "{}")).toMatchObject({
      plan: "family",
      trigger: "household"
    });
  });

  it("sends signed-out cooks to sign in with the chosen plan", async () => {
    authState.isAuthenticated = false;
    renderUpgradeHarness();

    fireEvent.click(screen.getByRole("button", { name: "import_limit" }));
    const dialog = await screen.findByRole("dialog", {
      name: "More room for the recipes worth keeping."
    });

    expect(within(dialog).getByRole("radio", { name: "Plus, $24.99/year" })).toBeChecked();
    expect(within(dialog).getByRole("link", { name: "Sign in to upgrade" })).toHaveAttribute(
      "href",
      "/account?upgrade=plus"
    );

    fireEvent.click(within(dialog).getByRole("radio", { name: "Family, $44.99/year" }));
    expect(within(dialog).getByRole("link", { name: "Sign in to upgrade" })).toHaveAttribute(
      "href",
      "/account?upgrade=family"
    );
    await waitFor(() => expect(apiMocks.getWebBillingAvailability).toHaveBeenCalled());
  });

  it("stays quiet for paid plans", () => {
    authState.plan = "plus";
    renderUpgradeHarness();

    fireEvent.click(screen.getByRole("button", { name: "save_limit" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).not.toHaveBeenCalled();
  });
});
