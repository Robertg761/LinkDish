import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, StyleSheet, View } from "react-native";

import { easeInOutCubic } from "../../../theme/easing";
import { appColors } from "../../../theme/tokens";

/** A decorative, looping cooking scene. It does not imply measurable progress. */
export const ExtractionAnimation = () => {
  const motion = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      motion.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(motion, {
          toValue: 1,
          duration: 1400,
          easing: easeInOutCubic,
          useNativeDriver: true
        }),
        Animated.timing(motion, {
          toValue: 0,
          duration: 1400,
          easing: easeInOutCubic,
          useNativeDriver: true
        })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [motion, reduceMotion]);

  return (
    <View
      style={styles.scene}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={styles.halo} />
      <Animated.View
        style={[
          styles.sparkle,
          styles.sparkleLeft,
          {
            opacity: motion.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
            transform: [
              { translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [3, -4] }) },
              { scale: motion.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.1] }) }
            ]
          }
        ]}
      >
        <MaterialCommunityIcons name="star-four-points" size={19} color="#ba8956" />
      </Animated.View>
      <Animated.View
        style={[
          styles.sparkle,
          styles.sparkleRight,
          {
            opacity: motion.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
            transform: [
              { translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [-3, 4] }) }
            ]
          }
        ]}
      >
        <MaterialCommunityIcons name="star-four-points" size={14} color="#ba8956" />
      </Animated.View>
      <Animated.View
        style={[
          styles.leaf,
          styles.leafLeft,
          {
            transform: [
              { translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) },
              {
                rotate: motion.interpolate({ inputRange: [0, 1], outputRange: ["-18deg", "8deg"] })
              }
            ]
          }
        ]}
      >
        <MaterialCommunityIcons name="leaf" size={22} color="#71947f" />
      </Animated.View>
      <Animated.View
        style={[
          styles.leaf,
          styles.leafRight,
          {
            transform: [
              { translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [-5, 3] }) },
              {
                rotate: motion.interpolate({ inputRange: [0, 1], outputRange: ["25deg", "-10deg"] })
              }
            ]
          }
        ]}
      >
        <MaterialCommunityIcons name="leaf" size={18} color="#9aae87" />
      </Animated.View>
      <Animated.View
        style={[
          styles.plate,
          {
            transform: [
              { translateY: motion.interpolate({ inputRange: [0, 1], outputRange: [2, -3] }) },
              { rotate: motion.interpolate({ inputRange: [0, 1], outputRange: ["-3deg", "3deg"] }) }
            ]
          }
        ]}
      >
        <View style={styles.plateInner}>
          <MaterialCommunityIcons name="silverware-fork-knife" size={42} color={appColors.accent} />
        </View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  scene: { width: 156, height: 146, alignItems: "center", justifyContent: "center" },
  halo: {
    position: "absolute",
    width: 124,
    height: 124,
    borderRadius: 62,
    backgroundColor: appColors.accentSoft
  },
  plate: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "#fffdf8",
    borderWidth: 2,
    borderColor: "#d4dfd4",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: appColors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 3
  },
  plateInner: {
    width: 67,
    height: 67,
    borderRadius: 34,
    borderWidth: 1,
    borderColor: "#e3ebe3",
    alignItems: "center",
    justifyContent: "center"
  },
  sparkle: { position: "absolute" },
  sparkleLeft: { left: 12, top: 25 },
  sparkleRight: { right: 14, bottom: 26 },
  leaf: { position: "absolute" },
  leafLeft: { left: 15, bottom: 27 },
  leafRight: { right: 15, top: 25 }
});
