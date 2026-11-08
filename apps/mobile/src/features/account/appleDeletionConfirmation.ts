import { Platform } from "react-native";

/*
 * Before an Apple-linked account is deleted on iOS, Apple is asked to confirm the person's Apple ID.
 * The authorization code it hands back lets the server revoke LinkDish's Sign in with Apple access.
 * (Clerk's own Apple sign-in only ever gives Clerk an identity token, so neither Clerk nor LinkDish
 * holds anything that could be revoked without this.)
 */

export type AppleDeletionConfirmation =
  | { authorizationCode: string; status: "confirmed" }
  /** The person closed Apple's prompt: the deletion is cancelled. */
  | { status: "cancelled" }
  /** Apple couldn't be asked: the deletion carries on and the person is told what to do. */
  | { status: "unavailable" };

/** Only on iOS (the only place Apple's prompt exists), and only for an Apple-linked account. */
export const needsAppleDeletionConfirmation = (hasAppleAccount: boolean): boolean =>
  Platform.OS === "ios" && hasAppleAccount;

export const confirmAccountDeletionWithApple = async (): Promise<AppleDeletionConfirmation> => {
  try {
    const AppleAuthentication = await import("expo-apple-authentication");
    // No name or email is asked for: only the Apple ID's confirmation.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });

    return credential.authorizationCode
      ? { authorizationCode: credential.authorizationCode, status: "confirmed" }
      : { status: "unavailable" };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_REQUEST_CANCELED") {
      return { status: "cancelled" };
    }

    console.warn("Couldn't ask Apple to confirm the account deletion.", error);
    return { status: "unavailable" };
  }
};
