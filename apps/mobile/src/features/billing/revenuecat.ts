import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { Platform } from "react-native";

import { mobileEnv } from "../../config/env";

import type { PaidBillingTier } from "./plans";
import type {
  CustomerInfo,
  CustomerInfoUpdateListener,
  PurchasesOffering,
  PurchasesPackage
} from "react-native-purchases";
import type * as RevenueCatPurchases from "react-native-purchases";

const APP_USER_ID_STORAGE_KEY = "linkdish.revenueCatAppUserId";

export const FOUNDING_LIFETIME_PACKAGE_IDENTIFIER = "founding_lifetime";

interface RevenueCatProductIdConfig {
  family: readonly string[];
  plus: readonly string[];
}

let purchasesModulePromise: Promise<typeof RevenueCatPurchases> | null = null;
let configuredAppUserId: string | null = null;

const loadPurchasesModule = async () => {
  purchasesModulePromise ??= import("react-native-purchases");
  return purchasesModulePromise;
};

const createLocalAppUserId = (): string => `linkdish_${randomUUID()}`;

export const getRevenueCatApiKey = (): string | null => {
  if (Platform.OS === "ios") {
    return mobileEnv.revenueCatIosApiKey ?? null;
  }

  if (Platform.OS === "android") {
    return mobileEnv.revenueCatAndroidApiKey ?? null;
  }

  return null;
};

export const getOrCreateRevenueCatAppUserId = async (): Promise<string> => {
  const storedAppUserId = await AsyncStorage.getItem(APP_USER_ID_STORAGE_KEY);

  if (storedAppUserId) {
    return storedAppUserId;
  }

  const appUserId = createLocalAppUserId();
  await AsyncStorage.setItem(APP_USER_ID_STORAGE_KEY, appUserId);
  return appUserId;
};

export const getActiveRevenueCatBillingTier = (
  customerInfo: CustomerInfo | null
): PaidBillingTier | null => {
  if (
    customerInfo?.entitlements.active[mobileEnv.revenueCatEntitlementIds.family]?.isActive === true
  ) {
    return "family";
  }

  if (
    customerInfo?.entitlements.active[mobileEnv.revenueCatEntitlementIds.plus]?.isActive === true
  ) {
    return "plus";
  }

  return null;
};

export const hasActiveRevenueCatPaidPlan = (customerInfo: CustomerInfo | null): boolean =>
  getActiveRevenueCatBillingTier(customerInfo) != null;

export const getRevenueCatPackageBillingTier = (
  purchasePackage: PurchasesPackage,
  productIds: RevenueCatProductIdConfig = mobileEnv.revenueCatProductIds
): PaidBillingTier => {
  const familyProductIds = productIds.family.map((item) => item.toLowerCase());
  const plusProductIds = productIds.plus.map((item) => item.toLowerCase());
  const configuredProductIds = new Set([...familyProductIds, ...plusProductIds]);
  const packageIds = [purchasePackage.product.identifier, purchasePackage.identifier].map((item) =>
    item.toLowerCase()
  );

  for (const packageId of packageIds) {
    if (configuredProductIds.has(packageId)) {
      return familyProductIds.includes(packageId) ? "family" : "plus";
    }
  }

  const packageText = [
    purchasePackage.identifier,
    purchasePackage.product.identifier,
    purchasePackage.product.title,
    purchasePackage.product.description
  ]
    .join(" ")
    .toLowerCase();

  return packageText.includes("family") || packageText.includes("household") ? "family" : "plus";
};

export const isFoundingLifetimePackage = (purchasePackage: PurchasesPackage): boolean =>
  purchasePackage.identifier === FOUNDING_LIFETIME_PACKAGE_IDENTIFIER;

export const getRevenueCatPackagePeriodLabel = (purchasePackage: PurchasesPackage): string => {
  const packageType = String(purchasePackage.packageType).toUpperCase();

  if (packageType === "ANNUAL") {
    return "Yearly";
  }

  if (packageType === "MONTHLY") {
    return "Monthly";
  }

  const packageText = [
    purchasePackage.identifier,
    purchasePackage.product.identifier,
    purchasePackage.product.title
  ]
    .join(" ")
    .toLowerCase();

  if (
    packageType === "LIFETIME" ||
    packageText.includes("founding") ||
    packageText.includes("lifetime")
  ) {
    return "Lifetime";
  }

  if (packageText.includes("annual") || packageText.includes("yearly")) {
    return "Yearly";
  }

  if (packageText.includes("monthly")) {
    return "Monthly";
  }

  return "Subscribe";
};

export const configureRevenueCat = async (
  requestedAppUserId?: string | null
): Promise<{
  appUserId: string | null;
  configured: boolean;
  customerInfo: CustomerInfo | null;
}> => {
  const appUserId = requestedAppUserId ?? (await getOrCreateRevenueCatAppUserId());
  const apiKey = getRevenueCatApiKey();

  if (!apiKey) {
    return {
      appUserId,
      configured: false,
      customerInfo: null
    };
  }

  const { default: Purchases, LOG_LEVEL } = await loadPurchasesModule();

  if (configuredAppUserId !== appUserId) {
    if (process.env.NODE_ENV !== "production") {
      await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    }

    Purchases.configure({
      apiKey,
      appUserID: appUserId
    });
    configuredAppUserId = appUserId;
  }

  return {
    appUserId,
    configured: true,
    customerInfo: await Purchases.getCustomerInfo()
  };
};

export const loginRevenueCatAccount = async (appUserId: string): Promise<CustomerInfo | null> => {
  const apiKey = getRevenueCatApiKey();

  if (!apiKey) {
    return null;
  }

  const { default: Purchases } = await loadPurchasesModule();

  if (configuredAppUserId !== appUserId) {
    const result = await Purchases.logIn(appUserId);
    configuredAppUserId = appUserId;
    return result.customerInfo;
  }

  return Purchases.getCustomerInfo();
};

export const logoutRevenueCatAccount = async (
  fallbackAppUserId?: string | null
): Promise<CustomerInfo | null> => {
  const apiKey = getRevenueCatApiKey();

  if (!apiKey) {
    return null;
  }

  const { default: Purchases } = await loadPurchasesModule();
  const customerInfo = await Purchases.logOut();
  configuredAppUserId = null;

  if (fallbackAppUserId) {
    return loginRevenueCatAccount(fallbackAppUserId);
  }

  return customerInfo;
};

export const addRevenueCatCustomerInfoListener = async (
  listener: CustomerInfoUpdateListener
): Promise<() => void> => {
  const { default: Purchases } = await loadPurchasesModule();
  Purchases.addCustomerInfoUpdateListener(listener);

  return () => {
    Purchases.removeCustomerInfoUpdateListener(listener);
  };
};

export const getRevenueCatOffering = async (): Promise<PurchasesOffering | null> => {
  const { default: Purchases } = await loadPurchasesModule();
  const offerings = await Purchases.getOfferings();

  if (mobileEnv.revenueCatOfferingId) {
    return offerings.all[mobileEnv.revenueCatOfferingId] ?? offerings.current;
  }

  return offerings.current;
};

export const purchaseRevenueCatPackage = async (
  purchasePackage: PurchasesPackage
): Promise<CustomerInfo> => {
  const { default: Purchases } = await loadPurchasesModule();
  const result = await Purchases.purchasePackage(purchasePackage);
  return result.customerInfo;
};

export const restoreRevenueCatPurchases = async (): Promise<CustomerInfo> => {
  const { default: Purchases } = await loadPurchasesModule();
  return Purchases.restorePurchases();
};

export const isRevenueCatPurchaseCancelled = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "userCancelled" in error &&
  (error as { userCancelled?: unknown }).userCancelled === true;

export type { CustomerInfo, PurchasesOffering, PurchasesPackage };
