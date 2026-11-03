import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

export const useSmoothKeyboardInset = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);

  useEffect(() => {
    if (!enabled || Platform.OS !== "android") {
      setKeyboardBottomInset(0);
      return undefined;
    }

    // Android exposes did-events here. Apply the inset as soon as each event arrives;
    // a second, unrelated layout animation would lag behind the keyboard.
    const keyboardShowSubscription = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardBottomInset(event.endCoordinates.height);
    });
    const keyboardHideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardBottomInset(0);
    });

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
    };
  }, [enabled]);

  return Platform.OS === "android" ? keyboardBottomInset : 0;
};
