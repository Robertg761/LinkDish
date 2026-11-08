import type { AccountDeletionProviders, AccountUser } from "@linkdish/api-contracts";

/**
 * What the person still has to do themselves once their account is deleted: anything a provider
 * couldn't do for us, and cancelling a store subscription, which deleting never does.
 */
export const getAccountDeletionFollowUps = (
  providers: AccountDeletionProviders,
  billingPlan: AccountUser["billingPlan"]
): string[] => {
  const followUps: string[] = [];

  if (providers.apple === "not_revoked") {
    followUps.push(
      "Turn off Sign in with Apple: LinkDish couldn't do it for you. Open Settings, tap your name, then Sign-In & Security, then Sign in with Apple, choose LinkDish, and stop using Sign in with Apple. You can also do this at account.apple.com."
    );
  }

  // Unknown counts as possibly paid: the reminder costs nothing, a missed one keeps a charge going.
  if (billingPlan !== "free") {
    followUps.push(
      "Cancel any subscription: deleting your account doesn't cancel it. If you subscribed in the App Store or Google Play, cancel it there, or you'll keep being charged."
    );
  }

  return followUps;
};

/** The message shown once the account is deleted, instead of a plain "done". */
export const getAccountDeletedMessage = (followUps: string[]): string =>
  followUps.length === 0
    ? "Your LinkDish account and its data have been deleted."
    : `Your LinkDish account has been deleted. There's still something only you can do:\n\n${followUps
        .map((followUp) => `• ${followUp}`)
        .join("\n\n")}`;
