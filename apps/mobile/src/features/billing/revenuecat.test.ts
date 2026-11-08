import { describe, expect, it, vi } from "vitest";

import {
  getRevenueCatPackageBillingTier,
  getNextRevenueCatExpiration,
  refreshRevenueCatCustomerInfo,
  getRevenueCatPackagePeriodLabel,
  isFoundingLifetimePackage
} from "./revenuecat";

import type { CustomerInfo, PurchasesPackage } from "react-native-purchases";

const sdk = vi.hoisted(() => ({ invalidateCustomerInfoCache: vi.fn(), getCustomerInfo: vi.fn() }));
vi.mock("react-native-purchases", () => ({ default: sdk }));
vi.mock("../../config/env", () => ({
  mobileEnv: {
    revenueCatEntitlementIds: { family: "Family", plus: "Plus" },
    revenueCatProductIds: { family: ["linkdish_family"], plus: ["linkdish_plus"] }
  }
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "android"
  }
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000001")
}));

const packageFor = ({
  description = "Monthly subscription",
  identifier = "$rc_monthly",
  packageType = "MONTHLY",
  productIdentifier,
  title = "Monthly subscription"
}: {
  description?: string;
  identifier?: string;
  packageType?: string;
  productIdentifier: string;
  title?: string;
}) =>
  ({
    identifier,
    packageType,
    product: {
      description,
      identifier: productIdentifier,
      title
    }
  }) as unknown as PurchasesPackage;

describe("getRevenueCatPackageBillingTier", () => {
  it("uses configured Play subscription ids before package text heuristics", () => {
    expect(
      getRevenueCatPackageBillingTier(
        packageFor({
          productIdentifier: "linkdish_family",
          title: "Premium"
        }),
        {
          family: ["linkdish_family"],
          plus: ["linkdish_plus"]
        }
      )
    ).toBe("family");

    expect(
      getRevenueCatPackageBillingTier(
        packageFor({
          productIdentifier: "linkdish_plus",
          title: "Premium Family-sized value"
        }),
        {
          family: ["linkdish_family"],
          plus: ["linkdish_plus"]
        }
      )
    ).toBe("plus");
  });

  it("falls back to plan words only when the product id is unknown", () => {
    expect(
      getRevenueCatPackageBillingTier(
        packageFor({
          productIdentifier: "remote_product",
          title: "Household plan"
        }),
        {
          family: ["linkdish_family"],
          plus: ["linkdish_plus"]
        }
      )
    ).toBe("family");
  });

  it("treats the founding lifetime package as a Plus tier purchase", () => {
    expect(
      getRevenueCatPackageBillingTier(
        packageFor({
          identifier: "founding_lifetime",
          packageType: "LIFETIME",
          productIdentifier: "linkdish_founding",
          title: "Founding Plus"
        }),
        {
          family: ["linkdish_family"],
          plus: ["linkdish_plus"]
        }
      )
    ).toBe("plus");
  });
});

describe("isFoundingLifetimePackage", () => {
  it("matches only the founding_lifetime package identifier", () => {
    expect(
      isFoundingLifetimePackage(
        packageFor({
          identifier: "founding_lifetime",
          packageType: "LIFETIME",
          productIdentifier: "linkdish_founding"
        })
      )
    ).toBe(true);

    expect(
      isFoundingLifetimePackage(
        packageFor({
          identifier: "$rc_monthly",
          productIdentifier: "linkdish_plus"
        })
      )
    ).toBe(false);
  });
});

describe("getRevenueCatPackagePeriodLabel", () => {
  it("labels the founding lifetime package as Lifetime", () => {
    expect(
      getRevenueCatPackagePeriodLabel(
        packageFor({
          identifier: "founding_lifetime",
          packageType: "LIFETIME",
          productIdentifier: "linkdish_founding",
          title: "Founding Plus"
        })
      )
    ).toBe("Lifetime");
  });

  it("still labels standard subscription packages", () => {
    expect(
      getRevenueCatPackagePeriodLabel(
        packageFor({
          identifier: "$rc_annual",
          packageType: "ANNUAL",
          productIdentifier: "linkdish_plus"
        })
      )
    ).toBe("Yearly");
  });
});

describe("fresh entitlement checks", () => {
  it("forces a fresh SDK read only when requested", async () => {
    sdk.getCustomerInfo.mockResolvedValue({});
    await refreshRevenueCatCustomerInfo(true);
    expect(sdk.invalidateCustomerInfoCache).toHaveBeenCalledOnce();
    expect(sdk.getCustomerInfo).toHaveBeenCalledOnce();
    expect(sdk.invalidateCustomerInfoCache.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.getCustomerInfo.mock.invocationCallOrder[0]!
    );
    await refreshRevenueCatCustomerInfo();
    expect(sdk.invalidateCustomerInfoCache).toHaveBeenCalledOnce();
    expect(sdk.getCustomerInfo).toHaveBeenCalledTimes(2);
  });

  it("schedules the nearest paid expiration, ignoring lifetime, expired, and unrelated entitlements", () => {
    const expiration = Date.now() + 30_000;
    const info = {
      entitlements: {
        active: {
          Plus: { identifier: "Plus", expirationDate: new Date(expiration).toISOString() },
          Family: { identifier: "Family", expirationDate: null },
          Other: { identifier: "Other", expirationDate: new Date(expiration - 1000).toISOString() }
        }
      }
    } as unknown as CustomerInfo;
    expect(getNextRevenueCatExpiration(info)).toBe(expiration);
    const expired = {
      ...info,
      entitlements: {
        ...info.entitlements,
        active: {
          ...info.entitlements.active,
          Plus: {
            ...info.entitlements.active.Plus!,
            expirationDate: new Date(Date.now() - 1000).toISOString()
          }
        }
      }
    };
    expect(getNextRevenueCatExpiration(expired)).toBeNull();
    expect(getNextRevenueCatExpiration(null)).toBeNull();
  });
});
