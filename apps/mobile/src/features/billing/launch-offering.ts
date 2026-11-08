import type { PaidBillingTier } from "./plans";

// Limit new iOS sales without changing existing entitlement recognition or Android offers.
export const iosLaunchProductId = "linkdish_plus_monthly";
export const isLaunchProductAvailable = (platform: string, productId: string): boolean =>
  platform !== "ios" || productId === iosLaunchProductId;
export const getLaunchPaidTiers = (platform: string): PaidBillingTier[] =>
  platform === "ios" ? ["plus"] : ["plus", "family"];
