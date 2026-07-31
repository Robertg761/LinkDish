import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPlanHeaderBadge } from "./SettingsPlanHeaderBadge";

const accountState = vi.hoisted(() => ({
  hasLoadedAccount: true,
  user: {
    email: "member@example.com",
    id: "user_member"
  } as { email: string; id: string } | null
}));

const billingState = vi.hoisted(() => ({
  plan: {
    displayName: "LinkDish Family",
    id: "family"
  }
}));

vi.mock("@linkdish/ui", () => ({
  AppChip: ({ label, tone }: { label: string; tone?: string }) =>
    React.createElement("AppChip", { label, tone }, label)
}));

vi.mock("react-native", () => ({
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("View", null, children)
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("../billing/BillingContext", () => ({
  useBilling: () => billingState
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsPlanHeaderBadge", () => {
  beforeEach(() => {
    accountState.hasLoadedAccount = true;
    accountState.user = {
      email: "member@example.com",
      id: "user_member"
    };
    billingState.plan = {
      displayName: "LinkDish Family",
      id: "family"
    };
  });

  it("shows the signed-in user's current billing plan", () => {
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<SettingsPlanHeaderBadge />);
    });
    const output = JSON.stringify(renderer!.toJSON());

    expect(output).toContain("LinkDish Family");
  });

  it("does not show a plan badge when signed out", () => {
    accountState.user = null;
    let renderer: ReturnType<typeof create>;

    act(() => {
      renderer = create(<SettingsPlanHeaderBadge />);
    });

    expect(renderer!.toJSON()).toBeNull();
  });
});
