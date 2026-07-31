import { useEffect, useState } from "react";
import { Keyboard, LayoutAnimation, Platform } from "react-native";

const configureSmoothKeyboardLayout = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
};

export const useSmoothKeyboardInset = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);

  useEffect(() => {
    if (!enabled || Platform.OS !== "android") {
      setKeyboardBottomInset(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener("keyboardDidShow", (event) => {
      configureSmoothKeyboardLayout();
      setKeyboardBottomInset(event.endCoordinates.height);
    });
    const keyboardHideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      configureSmoothKeyboardLayout();
      setKeyboardBottomInset(0);
    });

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
    };
  }, [enabled]);

  return Platform.OS === "android" ? keyboardBottomInset : 0;
};
