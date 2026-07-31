import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

const runAndroidHaptic = (action: () => Promise<void>) => {
  if (Platform.OS !== "android") {
    return;
  }

  try {
    void action().catch(() => undefined);
  } catch {
    // Haptics should never block a recipe interaction.
  }
};

export const selectionTick = () => {
  runAndroidHaptic(() => Haptics.selectionAsync());
};

export const success = () => {
  runAndroidHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
};

export const warn = () => {
  runAndroidHaptic(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
};
