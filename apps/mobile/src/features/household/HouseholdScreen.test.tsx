import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import HouseholdScreen from "../../../app/household";

import type { HouseholdDetails } from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  acceptHouseholdInvite: vi.fn(),
  createExtractorApiClient: vi.fn(),
  createHousehold: vi.fn(),
  createHouseholdInvite: vi.fn(),
  getHousehold: vi.fn()
}));

const accountState = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(),
  hasLoadedAccount: true,
  isSignedIn: true,
  refreshAccount: vi.fn(),
  user: {
    email: "family@example.com",
    id: "user_family"
  } as { email: string; id: string } | null
}));

const billingState = vi.hoisted(() => ({
  purchaseStatus: "idle",
  restorePurchases: vi.fn(),
  revenueCatConfigured: true,
  tier: "free" as "free" | "plus" | "family"
}));

const routerMocks = vi.hoisted(() => ({
  push: vi.fn()
}));

const savedRecipesMocks = vi.hoisted(() => ({
  refreshSharedRecipes: vi.fn()
}));

const upgradeMomentMocks = vi.hoisted(() => ({
  showUpgradeMoment: vi.fn()
}));

const shareMocks = vi.hoisted(() => ({
  share: vi.fn()
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("@linkdish/api-client", () => ({
  ExtractorApiError: class ExtractorApiError extends Error {
    public constructor(
      message: string,
      public readonly statusCode: number,
      public readonly details?: unknown
    ) {
      super(message);
    }
  },
  createExtractorApiClient: apiMocks.createExtractorApiClient
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: ({
    disabled,
    label,
    onPress,
    variant
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
    variant?: string;
  }) => React.createElement("AppButton", { disabled, label, onPress, variant }, label),
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({
    children,
    italic,
    tone
  }: {
    children?: React.ReactNode;
    italic?: boolean;
    tone?: string;
  }) => React.createElement("AppText", { italic, tone }, children)
}));

vi.mock("expo-router", () => ({
  router: routerMocks,
  useLocalSearchParams: () => ({})
}));

vi.mock("react-native", () => ({
  Alert: {
    alert: vi.fn()
  },
  Animated: {
    Value: class Value {
      public interpolate() {
        return 1;
      }
    },
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("Animated.View", null, children),
    timing: () => ({
      start: vi.fn()
    })
  },
  Easing: {
    cubic: vi.fn(),
    out: vi.fn()
  },
  Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? React.createElement("Modal", null, children) : null,
  Pressable: ({
    children,
    disabled,
    onPress,
    ...props
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
  }) => React.createElement("Pressable", { disabled, onPress, ...props }, children),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("ScrollView", null, children),
  Share: {
    share: shareMocks.share
  },
  StyleSheet: {
    absoluteFillObject: {},
    create: <T,>(styles: T) => styles
  },
  TextInput: (props: Record<string, unknown>) => React.createElement("TextInput", props),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("View", null, children)
}));

vi.mock("../../config/env", () => ({
  mobileEnv: {
    apiBaseUrl: "https://linkdish-api.test"
  }
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("../billing/BillingContext", () => ({
  useBilling: () => billingState
}));

vi.mock("../billing/UpgradeMomentContext", () => ({
  useOptionalUpgradeMoment: () => upgradeMomentMocks
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => savedRecipesMocks
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#6f5cff",
    accentSoft: "#ece9ff",
    border: "#e5e7eb",
    canvas: "#f8fafc",
    muted: "#64748b",
    surface: "#ffffff",
    text: "#111827"
  }
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const buildHousehold = (): HouseholdDetails => ({
  activeMemberCount: 1,
  cooldownSlotCount: 0,
  id: "household_1",
  invites: [],
  memberLimit: 6,
  members: [
    {
      email: "family@example.com",
      joinedAt: "2026-06-01T00:00:00.000Z",
      role: "owner",
      userId: "user_family"
    }
  ],
  ownerFamilyEntitlementActive: true,
  ownerUserId: "user_family",
  role: "owner"
});

describe("HouseholdScreen billing gate", () => {
  beforeEach(() => {
    accountState.getAuthHeaders.mockReset();
    accountState.getAuthHeaders.mockResolvedValue({
      authorization: "Bearer token"
    });
    accountState.refreshAccount.mockReset();
    accountState.refreshAccount.mockResolvedValue(undefined);
    accountState.hasLoadedAccount = true;
    accountState.isSignedIn = true;
    accountState.user = {
      email: "family@example.com",
      id: "user_family"
    };
    billingState.purchaseStatus = "idle";
    billingState.restorePurchases.mockReset();
    billingState.revenueCatConfigured = true;
    billingState.tier = "free";
    routerMocks.push.mockReset();
    upgradeMomentMocks.showUpgradeMoment.mockReset();
    savedRecipesMocks.refreshSharedRecipes.mockReset();
    savedRecipesMocks.refreshSharedRecipes.mockResolvedValue(undefined);
    apiMocks.getHousehold.mockReset();
    apiMocks.getHousehold.mockResolvedValue({
      household: null
    });
    apiMocks.acceptHouseholdInvite.mockReset();
    apiMocks.acceptHouseholdInvite.mockResolvedValue({
      household: buildHousehold()
    });
    apiMocks.createHousehold.mockReset();
    apiMocks.createHousehold.mockResolvedValue({
      household: buildHousehold()
    });
    apiMocks.createHouseholdInvite.mockReset();
    apiMocks.createHouseholdInvite.mockResolvedValue({
      household: buildHousehold(),
      invite: {
        email: "guest@example.com",
        expiresAt: "2026-08-01T00:00:00.000Z",
        id: "invite_1",
        inviteCode: "invite-code-123",
        inviteUrl: "https://join.linkdish.test/app/invite/?code=invite-code-123"
      }
    });
    shareMocks.share.mockReset();
    shareMocks.share.mockResolvedValue({ action: "sharedAction" });
    apiMocks.createExtractorApiClient.mockReset();
    apiMocks.createExtractorApiClient.mockReturnValue({
      acceptHouseholdInvite: apiMocks.acceptHouseholdInvite,
      cancelHouseholdInvite: vi.fn(),
      createHousehold: apiMocks.createHousehold,
      createHouseholdInvite: apiMocks.createHouseholdInvite,
      getHousehold: apiMocks.getHousehold,
      leaveHousehold: vi.fn(),
      removeHouseholdMember: vi.fn()
    });
  });

  it("lets server-verified Family users create a household without local RevenueCat customer info", async () => {
    billingState.tier = "family";
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HouseholdScreen />);
      await flushAsyncWork();
    });

    expect(JSON.stringify(renderer!.toJSON())).not.toContain("View plans");
    const createButton = renderer!.root.findByProps({
      label: "Create household"
    });
    const createButtonProps = createButton.props as { onPress: () => void };

    await act(async () => {
      createButtonProps.onPress();
      await flushAsyncWork();
    });

    expect(apiMocks.createHousehold).toHaveBeenCalledTimes(1);
    expect(savedRecipesMocks.refreshSharedRecipes).toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Your Family Household");
  });

  it("keeps non-Family users on the plan gate before creating a household", async () => {
    billingState.tier = "plus";

    await act(async () => {
      create(<HouseholdScreen />);
      await flushAsyncWork();
    });

    expect(apiMocks.createHousehold).not.toHaveBeenCalled();
  });

  it("opens the Family upgrade moment when non-Family users tap the household plan gate", async () => {
    billingState.tier = "plus";
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HouseholdScreen />);
      await flushAsyncWork();
    });

    const viewPlansButton = renderer!.root.findByProps({
      label: "View plans"
    });
    const viewPlansButtonProps = viewPlansButton.props as { onPress: () => void };

    act(() => {
      viewPlansButtonProps.onPress();
    });

    expect(upgradeMomentMocks.showUpgradeMoment).toHaveBeenCalledWith("share_to_family_no_plan");
    expect(routerMocks.push).not.toHaveBeenCalledWith("/upgrade");
  });

  it("refreshes the account plan after accepting a household invite", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HouseholdScreen />);
      await flushAsyncWork();
    });

    const inviteCodeInput = renderer!.root.findByProps({
      placeholder: "Invite code"
    });
    const inviteCodeInputProps = inviteCodeInput.props as { onChangeText: (value: string) => void };

    act(() => {
      inviteCodeInputProps.onChangeText("invite-code-123");
    });

    const acceptButton = renderer!.root.findByProps({
      label: "Accept invite"
    });
    const acceptButtonProps = acceptButton.props as { onPress: () => void };

    await act(async () => {
      acceptButtonProps.onPress();
      await flushAsyncWork();
    });

    expect(apiMocks.acceptHouseholdInvite).toHaveBeenCalledWith({
      inviteCode: "invite-code-123"
    });
    expect(accountState.refreshAccount).toHaveBeenCalled();
  });

  it("shares a warm household invite message with the invite code and link intact", async () => {
    billingState.tier = "family";
    apiMocks.getHousehold.mockResolvedValue({
      household: buildHousehold()
    });
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HouseholdScreen />);
      await flushAsyncWork();
    });

    const inviteMemberButton = renderer!.root.findByProps({
      accessibilityLabel: "Invite member"
    });

    act(() => {
      (inviteMemberButton.props as { onPress?: () => void }).onPress?.();
    });

    const emailInput = renderer!.root.findByProps({
      placeholder: "Member email"
    });

    act(() => {
      (emailInput.props as { onChangeText: (value: string) => void }).onChangeText(
        "guest@example.com"
      );
    });

    const sendInviteButton = renderer!.root.findByProps({
      label: "Send invite"
    });

    await act(async () => {
      (sendInviteButton.props as { onPress: () => void }).onPress();
      await flushAsyncWork();
    });

    const shareCodeButton = renderer!.root.findByProps({
      label: "Share code"
    });

    act(() => {
      (shareCodeButton.props as { onPress: () => void }).onPress();
    });

    expect(shareMocks.share).toHaveBeenCalledWith({
      message:
        "I saved you a seat in our LinkDish household. Join our shared cookbook and shopping list here:\nhttps://join.linkdish.test/app/invite/?code=invite-code-123\n\nInvite code: invite-code-123",
      title: "Join my LinkDish household"
    });
  });
});
