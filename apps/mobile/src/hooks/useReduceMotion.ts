import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Keep custom React Native animations in sync with the system preference. */
export const useReduceMotion = () => {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let active = true;
    let changed = false;
    const subscription = AccessibilityInfo?.addEventListener?.("reduceMotionChanged", (enabled) => {
      changed = true;
      setReduceMotion(enabled);
    });
    void AccessibilityInfo?.isReduceMotionEnabled?.().then((enabled) => {
      if (active && !changed) setReduceMotion(enabled);
    }).catch(() => undefined);
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);

  return reduceMotion;
};
