import { describe, expect, it, vi } from "vitest";

import {
  getRevenueCatPackageBillingTier,
  getRevenueCatPackagePeriodLabel,
  isFoundingLifetimePackage
} from "./revenuecat";

import type { PurchasesPackage } from "react-native-purchases";

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
