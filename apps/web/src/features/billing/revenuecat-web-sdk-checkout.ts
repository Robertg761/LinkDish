import type { AccountUser, BillingPeriod, PaidBillingPlan } from "@linkdish/api-contracts";
import type * as PurchasesModule from "@revenuecat/purchases-js";
import type { Package, Purchases as PurchasesInstance } from "@revenuecat/purchases-js";

type RevenueCatPurchasesModule = typeof PurchasesModule;

const revenueCatWebPublicApiKey = (
  import.meta.env.VITE_REVENUECAT_WEB_PUBLIC_API_KEY as string | undefined
)?.trim();

const packageIdentifiers: Record<PaidBillingPlan, Record<BillingPeriod, string>> = {
  family: {
    monthly: "family_monthly",
    yearly: "family_annual"
  },
  plus: {
    monthly: "$rc_monthly",
    yearly: "$rc_annual"
  }
};

export const FOUNDING_LIFETIME_PACKAGE_IDENTIFIER = "founding_lifetime";

let configuredUserId: string | null = null;
let purchasesModulePromise: Promise<RevenueCatPurchasesModule> | null = null;

export const isRevenueCatWebSdkCheckoutConfigured = (): boolean =>
  Boolean(revenueCatWebPublicApiKey);

const loadPurchasesModule = (): Promise<RevenueCatPurchasesModule> => {
  purchasesModulePromise ??= import("@revenuecat/purchases-js");
  return purchasesModulePromise;
};

const getPurchasesForUser = async (user: AccountUser): Promise<PurchasesInstance> => {
  if (!revenueCatWebPublicApiKey) {
    throw new Error("RevenueCat Web Billing is not configured for this build.");
  }

  const { Purchases } = await loadPurchasesModule();

  if (!Purchases.isConfigured()) {
    configuredUserId = user.id;
    return Purchases.configure({
      apiKey: revenueCatWebPublicApiKey,
      appUserId: user.id
    });
  }

  const purchases = Purchases.getSharedInstance();

  if (configuredUserId !== user.id) {
    await purchases.changeUser(user.id);
    configuredUserId = user.id;
  }

  return purchases;
};

const getCheckoutPackage = async (
  purchases: PurchasesInstance,
  plan: PaidBillingPlan,
  period: BillingPeriod
): Promise<Package> => {
  const offerings = await purchases.getOfferings();
  const packageIdentifier = packageIdentifiers[plan][period];
  const checkoutPackage = offerings.current?.availablePackages.find(
    (candidate) => candidate.identifier === packageIdentifier
  );

  if (!checkoutPackage) {
    throw new Error("This RevenueCat checkout option is not available right now.");
  }

  return checkoutPackage;
};

export const startRevenueCatWebSdkCheckout = async ({
  period,
  plan,
  user
}: {
  period: BillingPeriod;
  plan: PaidBillingPlan;
  user: AccountUser;
}): Promise<void> => {
  const purchases = await getPurchasesForUser(user);
  const checkoutPackage = await getCheckoutPackage(purchases, plan, period);

  await purchases.purchase({
    customerEmail: user.email,
    rcPackage: checkoutPackage
  });
};

const getFoundingCheckoutPackage = async (purchases: PurchasesInstance): Promise<Package> => {
  const offerings = await purchases.getOfferings();
  const checkoutPackage = offerings.current?.availablePackages.find(
    (candidate) => candidate.identifier === FOUNDING_LIFETIME_PACKAGE_IDENTIFIER
  );

  if (!checkoutPackage) {
    throw new Error("This RevenueCat checkout option is not available right now.");
  }

  return checkoutPackage;
};

export const startRevenueCatWebSdkFoundingCheckout = async ({
  user
}: {
  user: AccountUser;
}): Promise<void> => {
  const purchases = await getPurchasesForUser(user);
  const checkoutPackage = await getFoundingCheckoutPackage(purchases);

  await purchases.purchase({
    customerEmail: user.email,
    rcPackage: checkoutPackage
  });
};
