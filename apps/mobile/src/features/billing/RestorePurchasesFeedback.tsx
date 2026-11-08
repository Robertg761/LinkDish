import { AppText } from "@linkdish/ui";
import { View } from "react-native";

import { useBilling } from "./BillingContext";

/** Shared by every restore entry point, including when restoring unlocks the current screen. */
export const RestorePurchasesFeedback = () => {
  const { purchaseStatus, restoreMessage } = useBilling();
  const message =
    purchaseStatus === "restoring"
      ? "Checking your store purchases and refreshing your LinkDish access…"
      : restoreMessage;
  return message ? (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <AppText>{message}</AppText>
    </View>
  ) : null;
};
