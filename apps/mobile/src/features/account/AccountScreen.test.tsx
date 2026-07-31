import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AccountScreen from "../../../app/(tabs)/account";

const apiMocks = vi.hoisted(() => ({
  acceptHouseholdInvite: vi.fn(),
  createExtractorApiClient: vi.fn()
}));

const accountState = vi.hoisted(() => ({
  accountError: null as string | null,
  deleteAccount: vi.fn(),
  getAuthHeaders: vi.fn(),
  hasLoadedAccount: true,
  isAccountBusy: false,
  isClerkSignInEnabled: false,
  isEmailCodeSignInEnabled: true,
  logout: vi.fn(),
  refreshAccount: vi.fn(),
  requestCode: vi.fn(),
  signInWithDebugHousehold: vi.fn(),
  updateProfile: vi.fn(),
  user: {
    avatarEmoji: null as string | null,
    displayName: null as string | null,
    email: "member@example.com",
    id: "user_member"
  },
  verifyCode: vi.fn()
}));

const billingState = vi.hoisted(() => ({
  purchaseStatus: "idle",
  restorePurchases: vi.fn()
}));

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn()
}));

const savedRecipesMocks = vi.hoisted(() => ({
  refreshSharedRecipes: vi.fn()
}));

const canonicalAppColors = vi.hoisted(() => {
  const hex = (value: string) => ["#", value].join("");

  return {
    accent: hex("29443b"),
    accentSoft: hex("dde7df"),
    background: hex("f4efe7"),
    border: hex("ddd2c3"),
    canvas: hex("fbf7f0"),
    danger: hex("9a523f"),
    muted: hex("6e685f"),
    text: hex("1f211d")
  };
});

vi.mock("@clerk/expo/apple", () => ({
  useSignInWithApple: () => ({
    startAppleAuthenticationFlow: vi.fn()
  })
}));

vi.mock("@clerk/expo/google", () => ({
  useSignInWithGoogle: () => ({
    startGoogleAuthenticationFlow: vi.fn()
  })
}));

vi.mock("expo-crypto", () => ({}));

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

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 })
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

      public setValue() {
        return undefined;
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
    in: vi.fn(),
    out: vi.fn()
  },
  Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
    visible ? React.createElement("Modal", null, children) : null,
  Platform: {
    OS: "android"
  },
  Pressable: ({
    children,
    disabled,
    onPress
  }: {
    children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    React.createElement(
      "Pressable",
      { disabled, onPress },
      typeof children === "function" ? children({ pressed: false }) : children
    ),
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("ScrollView", null, children),
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
    apiBaseUrl: "https://linkdish-api.test",
    debugHouseholdSimulatorEnabled: false
  }
}));

vi.mock("./AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("./ClerkSessionContext", () => ({
  useClerkSession: () => ({
    isSignedIn: false,
    setActiveSession: vi.fn()
  })
}));

vi.mock("../billing/BillingContext", () => ({
  useBilling: () => billingState
}));

vi.mock("../saved-recipes/SavedRecipesContext", () => ({
  useSavedRecipes: () => savedRecipesMocks
}));

vi.mock("../../theme/tokens", () => ({
  appColors: canonicalAppColors,
  appSpacing: {
    md: 12,
    xs: 4
  }
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("AccountScreen household actions", () => {
  beforeEach(() => {
    accountState.accountError = null;
    accountState.deleteAccount.mockReset();
    accountState.getAuthHeaders.mockReset();
    accountState.getAuthHeaders.mockResolvedValue({
      authorization: "Bearer token"
    });
    accountState.hasLoadedAccount = true;
    accountState.isAccountBusy = false;
    accountState.isClerkSignInEnabled = false;
    accountState.isEmailCodeSignInEnabled = true;
    accountState.logout.mockReset();
    accountState.refreshAccount.mockReset();
    accountState.refreshAccount.mockResolvedValue(undefined);
    accountState.requestCode.mockReset();
    accountState.signInWithDebugHousehold.mockReset();
    accountState.updateProfile.mockReset();
    accountState.user = {
      avatarEmoji: null,
      displayName: null,
      email: "member@example.com",
      id: "user_member"
    };
    accountState.verifyCode.mockReset();
    billingState.purchaseStatus = "idle";
    billingState.restorePurchases.mockReset();
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    savedRecipesMocks.refreshSharedRecipes.mockReset();
    savedRecipesMocks.refreshSharedRecipes.mockResolvedValue(undefined);
    apiMocks.acceptHouseholdInvite.mockReset();
    apiMocks.acceptHouseholdInvite.mockResolvedValue({
      household: {
        id: "household_1"
      }
    });
    apiMocks.createExtractorApiClient.mockReset();
    apiMocks.createExtractorApiClient.mockReturnValue({
      acceptHouseholdInvite: apiMocks.acceptHouseholdInvite
    });
  });

  it("opens a join household modal and accepts an invite code", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<AccountScreen />);
      await flushAsyncWork();
    });

    const joinButton = renderer!.root.findByProps({
      label: "Join Household"
    });

    act(() => {
      (joinButton.props as { onPress: () => void }).onPress();
    });

    const inviteCodeInput = renderer!.root.findByProps({
      placeholder: "Invite code"
    });

    act(() => {
      (inviteCodeInput.props as { onChangeText: (value: string) => void }).onChangeText(
        "invite-code-123"
      );
    });

    const acceptButton = renderer!.root.findByProps({
      label: "Accept invite"
    });

    await act(async () => {
      (acceptButton.props as { onPress: () => void }).onPress();
      await flushAsyncWork();
    });

    expect(apiMocks.acceptHouseholdInvite).toHaveBeenCalledWith({
      inviteCode: "invite-code-123"
    });
    expect(accountState.refreshAccount).toHaveBeenCalled();
    expect(savedRecipesMocks.refreshSharedRecipes).toHaveBeenCalled();
    expect(routerMocks.push).toHaveBeenCalledWith("/household");
  });

  it("does not render the old shopping-list card in Household", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<AccountScreen />);
      await flushAsyncWork();
    });

    const output = JSON.stringify(renderer!.toJSON());
    expect(output).not.toContain("Open shopping list");
    expect(output).not.toContain("Keep a personal grocery list");
    expect(output).toContain("Manage Household");
  });
});
