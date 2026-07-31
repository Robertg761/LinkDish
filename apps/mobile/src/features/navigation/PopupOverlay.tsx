import { BlurView } from "expo-blur";
import { type ReactNode } from "react";
import { Animated, Platform, Pressable, StyleSheet, View } from "react-native";

import { appColors } from "../../theme/tokens";

const BACKDROP_BLUR_INTENSITY = Platform.select({ android: 6, default: 48, ios: 48 });
const BACKDROP_BLUR_REDUCTION = Platform.OS === "android" ? 2 : 4;
const BACKDROP_BLUR_TINT: "dark" | "default" = Platform.OS === "android" ? "dark" : "default";
const BACKDROP_TINT_COLOR =
  Platform.OS === "android" ? appColors.backdropLight : "rgba(31, 33, 29, 0.01)";
const shouldUseBackdropBlur = Platform.OS !== "android";

const PopupBackdrop = ({ progress }: { progress: Animated.Value }) => (
  <Animated.View
    pointerEvents="none"
    style={[
      styles.backdrop,
      {
        opacity: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, 1]
        })
      }
    ]}
  >
    {shouldUseBackdropBlur ? (
      <BlurView
        blurReductionFactor={BACKDROP_BLUR_REDUCTION}
        intensity={BACKDROP_BLUR_INTENSITY}
        style={StyleSheet.absoluteFill}
        tint={BACKDROP_BLUR_TINT}
      />
    ) : null}
    <View style={styles.backdropTint} />
  </Animated.View>
);

export const PopupLayer = ({
  children,
  onBackdropPress,
  progress
}: {
  children: ReactNode;
  onBackdropPress: () => void;
  progress: Animated.Value;
}) => (
  <View style={styles.overlayLayer}>
    <View style={styles.overlay}>
      <PopupBackdrop progress={progress} />
      <Pressable onPress={onBackdropPress} style={styles.backdropPressable} />
      <View pointerEvents="box-none" style={styles.contentLayer}>
        {children}
      </View>
    </View>
  </View>
);

export const PopupPortal = ({ children }: { children: ReactNode }) => (
  <View pointerEvents="box-none" style={styles.overlayPortal}>
    {children}
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    zIndex: 0
  },
  backdropPressable: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    zIndex: 1
  },
  backdropTint: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: BACKDROP_TINT_COLOR
  },
  contentLayer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    zIndex: 2
  },
  overlay: {
    flex: 1
  },
  overlayLayer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0
  },
  overlayPortal: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    elevation: 999,
    zIndex: 999
  }
});
