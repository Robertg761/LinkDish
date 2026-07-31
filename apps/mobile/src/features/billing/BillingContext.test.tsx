import React from "react";
import { Text } from "react-native";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingProvider, useBilling } from "./BillingContext";

const mockAccountState = vi.hoisted(() => ({
  hasLoadedAccount: true,
  user: null as { billingPlan?: "free" | "plus" | "family"; email: string; id: string } | null
}));

const revenueCatMocks = vi.hoisted(() => ({
  addRevenueCatCustomerInfoListener: vi.fn(),
  configureRevenueCat: vi.fn(),
  getActiveRevenueCatBillingTier: vi.fn(),
  getOrCreateRevenueCatAppUserId: vi.fn(),
  getRevenueCatPackageBillingTier: vi.fn(),
  getRevenueCatPackagePeriodLabel: vi.fn(),
  getRevenueCatOffering: vi.fn(),
  hasActiveRevenueCatPaidPlan: vi.fn(),
  isRevenueCatPurchaseCancelled: vi.fn(),
  loginRevenueCatAccount: vi.fn(),
  logoutRevenueCatAccount: vi.fn(),
  purchaseRevenueCatPackage: vi.fn(),
  restoreRevenueCatPurchases: vi.fn()
}));

const analyticsMocks = vi.hoisted(() => ({
  trackMobileEvent: vi.fn()
}));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const mobileEnvState = vi.hoisted(() => ({
  localPlanPreviewEnabled: false
}));

vi.mock("react-native", () => ({
  Text: ({ children }: { children: React.ReactNode }) => React.createElement("text", null, children)
}));

vi.mock("../../analytics/client", () => ({
  trackMobileEvent: analyticsMocks.trackMobileEvent
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("../../config/env", () => ({
  mobileEnv: mobileEnvState
}));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => mockAccountState
}));

vi.mock("./revenuecat", () => ({
  addRevenueCatCustomerInfoListener: revenueCatMocks.addRevenueCatCustomerInfoListener,
  configureRevenueCat: revenueCatMocks.configureRevenueCat,
  getActiveRevenueCatBillingTier: revenueCatMocks.getActiveRevenueCatBillingTier,
  getOrCreateRevenueCatAppUserId: revenueCatMocks.getOrCreateRevenueCatAppUserId,
  getRevenueCatPackageBillingTier: revenueCatMocks.getRevenueCatPackageBillingTier,
  getRevenueCatPackagePeriodLabel: revenueCatMocks.getRevenueCatPackagePeriodLabel,
  getRevenueCatOffering: revenueCatMocks.getRevenueCatOffering,
  hasActiveRevenueCatPaidPlan: revenueCatMocks.hasActiveRevenueCatPaidPlan,
  isRevenueCatPurchaseCancelled: revenueCatMocks.isRevenueCatPurchaseCancelled,
  loginRevenueCatAccount: revenueCatMocks.loginRevenueCatAccount,
  logoutRevenueCatAccount: revenueCatMocks.logoutRevenueCatAccount,
  purchaseRevenueCatPackage: revenueCatMocks.purchaseRevenueCatPackage,
  restoreRevenueCatPurchases: revenueCatMocks.restoreRevenueCatPurchases
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latestBilling: ReturnType<typeof useBilling> | null = null;

const Probe = () => {
  const billing = useBilling();
  latestBilling = billing;
  return (
    <Text>
      {JSON.stringify({
        hasLoadedBilling: billing.hasLoadedBilling,
        purchaseError: billing.purchaseError,
        purchaseStatus: billing.purchaseStatus,
        revenueCatAppUserId: billing.revenueCatAppUserId,
        tier: billing.tier
      })}
    </Text>
  );
};

const App = () => (
  <BillingProvider>
    <Probe />
  </BillingProvider>
);

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  latestBilling = null;
  mockAccountState.hasLoadedAccount = true;
  mockAccountState.user = null;
  mobileEnvState.localPlanPreviewEnabled = false;
  asyncStorageMocks.getItem.mockReset();
  asyncStorageMocks.setItem.mockReset();
  asyncStorageMocks.getItem.mockResolvedValue(null);
  asyncStorageMocks.setItem.mockResolvedValue(undefined);
  analyticsMocks.trackMobileEvent.mockReset();

  for (const mock of Object.values(revenueCatMocks)) {
    mock.mockReset();
  }

  revenueCatMocks.addRevenueCatCustomerInfoListener.mockResolvedValue(() => undefined);
  revenueCatMocks.configureRevenueCat.mockResolvedValue({
    appUserId: "local-revenuecat-id",
    configured: true,
    customerInfo: null
  });
  revenueCatMocks.getActiveRevenueCatBillingTier.mockReturnValue(null);
  revenueCatMocks.getOrCreateRevenueCatAppUserId.mockResolvedValue("local-revenuecat-id");
  revenueCatMocks.getRevenueCatPackageBillingTier.mockReturnValue("plus");
  revenueCatMocks.getRevenueCatPackagePeriodLabel.mockReturnValue("Monthly");
  revenueCatMocks.getRevenueCatOffering.mockResolvedValue(null);
  revenueCatMocks.hasActiveRevenueCatPaidPlan.mockReturnValue(false);
  revenueCatMocks.isRevenueCatPurchaseCancelled.mockReturnValue(false);
  revenueCatMocks.loginRevenueCatAccount.mockResolvedValue(null);
  revenueCatMocks.logoutRevenueCatAccount.mockResolvedValue(null);
  revenueCatMocks.purchaseRevenueCatPackage.mockResolvedValue({} as never);
});

const fakePurchasePackage = {
  identifier: "$rc_monthly",
  packageType: "MONTHLY",
  product: {
    description: "Monthly",
    identifier: "linkdish_plus",
    priceString: "$2.99",
    title: "LinkDish Plus"
  }
} as never;

describe("BillingProvider account identity sync", () => {
  it("logs RevenueCat into the account user id and returns to the local id on sign-out", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.configureRevenueCat).toHaveBeenCalledWith("local-revenuecat-id");

    mockAccountState.user = {
      email: "user@example.com",
      id: "user_123"
    };

    await act(async () => {
      renderer!.update(<App />);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.loginRevenueCatAccount).toHaveBeenCalledWith("user_123");

    mockAccountState.user = null;

    await act(async () => {
      renderer!.update(<App />);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.logoutRevenueCatAccount).toHaveBeenCalledWith("local-revenuecat-id");
  });

  it("does not expose stale RevenueCat entitlements while switching accounts", async () => {
    const familyCustomerInfo = { active: "family" } as never;
    let resolveSecondLogin!: (value: null) => void;
    const secondLogin = new Promise<null>((resolve) => {
      resolveSecondLogin = resolve;
    });
    revenueCatMocks.getActiveRevenueCatBillingTier.mockImplementation((customerInfo) =>
      customerInfo === familyCustomerInfo ? "family" : null
    );
    revenueCatMocks.loginRevenueCatAccount.mockImplementation((appUserId) =>
      appUserId === "user_family" ? Promise.resolve(familyCustomerInfo) : secondLogin
    );
    mockAccountState.user = {
      billingPlan: "family",
      email: "family@example.com",
      id: "user_family"
    };
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"family"');

    mockAccountState.user = {
      billingPlan: "free",
      email: "free@example.com",
      id: "user_free"
    };

    act(() => {
      renderer!.update(<App />);
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"free"');
    expect(renderer!.root.findByType("text").props.children).toContain(
      '"revenueCatAppUserId":"user_free"'
    );

    await act(async () => {
      resolveSecondLogin(null);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"free"');
  });

  it("uses the server-verified account billing plan for signed-in users", async () => {
    mockAccountState.user = {
      billingPlan: "family",
      email: "family@example.com",
      id: "user_family"
    };
    revenueCatMocks.loginRevenueCatAccount.mockResolvedValue(null);
    revenueCatMocks.getActiveRevenueCatBillingTier.mockReturnValue(null);
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"family"');
  });

  it("updates the visible tier when the server plan changes for the current account", async () => {
    mockAccountState.user = {
      billingPlan: "free",
      email: "member@example.com",
      id: "user_member"
    };
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"free"');

    mockAccountState.user = {
      billingPlan: "family",
      email: "member@example.com",
      id: "user_member"
    };

    await act(async () => {
      renderer!.update(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"family"');
  });

  it("blocks purchase and restore actions until the user is signed in", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    await act(async () => {
      await latestBilling!.purchasePackage(fakePurchasePackage);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.purchaseRevenueCatPackage).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("text").props.children).toContain("Sign in before choosing");

    await act(async () => {
      await latestBilling!.restorePurchases();
      await flushAsyncWork();
    });

    expect(revenueCatMocks.restoreRevenueCatPurchases).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("text").props.children).toContain("Sign in before restoring");
  });

  it("forces RevenueCat onto the LinkDish account identity before purchasing", async () => {
    mockAccountState.user = {
      email: "user@example.com",
      id: "user_123"
    };

    await act(async () => {
      create(<App />);
      await flushAsyncWork();
    });

    await act(async () => {
      await latestBilling!.purchasePackage(fakePurchasePackage);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.loginRevenueCatAccount).toHaveBeenCalledWith("user_123");
    expect(revenueCatMocks.purchaseRevenueCatPackage).toHaveBeenCalledWith(fakePurchasePackage);
    expect(latestBilling?.purchaseError).toBeNull();
    expect(latestBilling?.purchaseStatus).toBe("idle");
    expect(analyticsMocks.trackMobileEvent).toHaveBeenCalledWith({
      eventName: "upgrade_purchased",
      properties: {
        billing_period: "monthly",
        plan: "plus"
      },
      routeOrScreen: "upgrade"
    });
  });
});

describe("BillingProvider local plan preview", () => {
  it("does not use local plan preview unless it is explicitly enabled", async () => {
    asyncStorageMocks.getItem.mockResolvedValue(
      JSON.stringify({
        tier: "family",
        usage: {
          imports: 0,
          periodKey: "2026-05",
          strongExtractions: 0
        },
        usageAccountingVersion: 2
      })
    );
    revenueCatMocks.configureRevenueCat.mockResolvedValue({
      appUserId: "local-revenuecat-id",
      configured: false,
      customerInfo: null
    });

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"free"');

    await act(async () => {
      latestBilling!.activatePlanPreview("plus");
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"free"');
  });

  it("uses local plan preview when explicitly enabled and RevenueCat is unavailable", async () => {
    mobileEnvState.localPlanPreviewEnabled = true;
    asyncStorageMocks.getItem.mockResolvedValue(
      JSON.stringify({
        tier: "family",
        usage: {
          imports: 0,
          periodKey: "2026-05",
          strongExtractions: 0
        },
        usageAccountingVersion: 2
      })
    );
    revenueCatMocks.configureRevenueCat.mockResolvedValue({
      appUserId: "local-revenuecat-id",
      configured: false,
      customerInfo: null
    });

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"family"');
  });

  it("uses local plan preview without configuring RevenueCat", async () => {
    mobileEnvState.localPlanPreviewEnabled = true;
    asyncStorageMocks.getItem.mockResolvedValue(
      JSON.stringify({
        tier: "plus",
        usage: {
          imports: 0,
          periodKey: "2026-05",
          strongExtractions: 0
        },
        usageAccountingVersion: 2
      })
    );

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(revenueCatMocks.configureRevenueCat).not.toHaveBeenCalled();
    expect(revenueCatMocks.getRevenueCatOffering).not.toHaveBeenCalled();
    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"plus"');
  });

  it("defaults fresh local plan preview installs to Family", async () => {
    mobileEnvState.localPlanPreviewEnabled = true;
    asyncStorageMocks.getItem.mockResolvedValue(null);

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<App />);
      await flushAsyncWork();
    });

    expect(renderer!.root.findByType("text").props.children).toContain('"tier":"family"');
  });
});
