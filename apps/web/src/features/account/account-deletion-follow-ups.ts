import type { AccountDeletionProviders, AccountUser } from "@linkdish/api-contracts";

export interface AccountDeletionFollowUp {
  id: "apple" | "subscription" | "provider-cleanup";
  title: string;
  body: string;
}

/**
 * What the person still has to do themselves after their account was deleted: anything a provider
 * couldn't do for us, and cancelling a store subscription, which deleting never does.
 */
export const getAccountDeletionFollowUps = (
  providers: AccountDeletionProviders,
  billingPlan: AccountUser["billingPlan"]
): AccountDeletionFollowUp[] => {
  const followUps: AccountDeletionFollowUp[] = [];

  if (Object.values(providers).includes("unknown")) {
    followUps.push({
      id: "provider-cleanup",
      title: "Confirm provider cleanup",
      body: "Provider cleanup was not confirmed by this server. Contact support@linkdish.ca to confirm deletion at Clerk and RevenueCat. If you used Sign in with Apple, remove LinkDish in your Apple Account settings."
    });
  }

  if (providers.apple === "not_revoked") {
    followUps.push({
      body: "LinkDish couldn't turn off Sign in with Apple for you. In your Apple Account settings (on an iPhone: Settings, your name, Sign-In & Security, Sign in with Apple; or at account.apple.com), choose LinkDish and stop using Sign in with Apple.",
      id: "apple",
      title: "Turn off Sign in with Apple"
    });
  }

  // Unknown counts as possibly paid: the reminder costs nothing, a missed one keeps a charge going.
  if (billingPlan !== "free") {
    followUps.push({
      body: "Deleting your account doesn't cancel a subscription. If you subscribed in the App Store or Google Play, cancel it there, or you'll keep being charged. If you subscribed on the web and can't cancel it, email support@linkdish.ca.",
      id: "subscription",
      title: "Cancel any subscription"
    });
  }

  return followUps;
};
