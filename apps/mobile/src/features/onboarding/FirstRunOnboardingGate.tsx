import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import React from "react";
import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { appColors, appSpacing } from "../../theme/tokens";

export const ONBOARDING_STORAGE_KEY = "linkdish.hasSeenOnboarding";

export const onboardingFrames = [
  {
    body: "Send links, screenshots, and weeknight finds into a Cookbook that starts with something useful.",
    title: "Save recipes from anywhere",
    variant: "save"
  },
  {
    body: "Open cook mode and LinkDish clears the counter: big steps, ingredients, and timers — no browser clutter.",
    title: "Cook without losing your place",
    variant: "cook"
  },
  {
    body: "Family keeps one shared recipe book and one monthly import allowance for the household.",
    title: "Share the kitchen",
    variant: "family"
  }
] as const;

const OnboardingIllustration = ({
  variant
}: {
  variant: (typeof onboardingFrames)[number]["variant"];
}) => {
  if (variant === "cook") {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.art}
      >
        <View style={styles.cookPanel}>
          <View style={styles.cookLineWide} />
          <View style={styles.cookLineShort} />
        </View>
        <View style={styles.timerPill}>
          <View style={styles.butterDot} />
          <View style={styles.timerLine} />
        </View>
      </View>
    );
  }

  if (variant === "family") {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.art}
      >
        <View style={styles.familyPlateBack} />
        <View style={styles.familyPlateFront} />
        <View style={styles.familyChip}>
          <View style={styles.checkStem} />
          <View style={styles.checkArm} />
        </View>
      </View>
    );
  }

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.art}
    >
      <View style={styles.saveRow}>
        <View style={styles.urlPill}>
          <View style={styles.butterDot} />
          <View style={styles.urlLine} />
        </View>
        <View style={styles.saveArrow}>
          <View style={styles.arrowLine} />
          <View style={styles.arrowHeadTop} />
          <View style={styles.arrowHeadBottom} />
        </View>
        <View style={styles.bookWrap}>
          <View style={styles.bookLeftPage} />
          <View style={styles.bookRightPage} />
          <View style={styles.bookSpine} />
        </View>
      </View>
    </View>
  );
};

export const FirstRunOnboardingGate = () => {
  const [hasLoadedOnboarding, setHasLoadedOnboarding] = useState(false);
  const [isOnboardingVisible, setIsOnboardingVisible] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const { width } = useWindowDimensions();
  const frame = onboardingFrames[frameIndex] ?? onboardingFrames[0];
  const isLastFrame = frameIndex === onboardingFrames.length - 1;

  useEffect(() => {
    let isMounted = true;

    const hydrateOnboarding = async () => {
      try {
        const storedValue = await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY);

        if (isMounted) {
          setIsOnboardingVisible(storedValue !== "true");
        }
      } catch (error) {
        console.warn("Failed to load onboarding state.", error);
      } finally {
        if (isMounted) {
          setHasLoadedOnboarding(true);
        }
      }
    };

    void hydrateOnboarding();

    return () => {
      isMounted = false;
    };
  }, []);

  const completeOnboarding = async () => {
    setIsOnboardingVisible(false);
    router.replace("/" as never);

    try {
      await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    } catch (error) {
      console.warn("Failed to persist onboarding state.", error);
    }
  };

  if (!hasLoadedOnboarding || !isOnboardingVisible) {
    return null;
  }

  return (
    <Modal animationType="fade" onRequestClose={completeOnboarding} transparent visible>
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="Skip onboarding"
          accessibilityRole="button"
          onPress={() => void completeOnboarding()}
          style={styles.backdrop}
        />
        <AppSurface style={[styles.sheet, { width: Math.min(width - 28, 520) }]}>
          <View style={styles.header}>
            <OnboardingIllustration variant={frame.variant} />
            <AppText style={styles.title} variant="headline">
              {frame.title}
            </AppText>
            <AppText muted style={styles.body}>
              {frame.body}
            </AppText>
          </View>

          <View style={styles.progress}>
            {onboardingFrames.map((item, index) => (
              <View
                key={item.title}
                style={[styles.progressDot, index === frameIndex && styles.progressDotActive]}
              />
            ))}
          </View>

          <View style={styles.actions}>
            <AppButton
              label={isLastFrame ? "Start cooking" : "Next"}
              onPress={() => {
                if (isLastFrame) {
                  void completeOnboarding();
                  return;
                }

                setFrameIndex((current) => Math.min(current + 1, onboardingFrames.length - 1));
              }}
            />
            {!isLastFrame ? (
              <AppButton label="Skip" onPress={() => void completeOnboarding()} variant="ghost" />
            ) : null}
          </View>
        </AppSurface>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  actions: {
    gap: appSpacing.sm
  },
  art: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.border,
    borderRadius: 20,
    borderWidth: 1,
    height: 150,
    justifyContent: "center",
    overflow: "hidden",
    position: "relative",
    width: "100%"
  },
  arrowHeadBottom: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 4,
    position: "absolute",
    right: -1,
    top: 12,
    transform: [{ rotate: "-42deg" }],
    width: 13
  },
  arrowHeadTop: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 4,
    position: "absolute",
    right: -1,
    top: 4,
    transform: [{ rotate: "42deg" }],
    width: 13
  },
  arrowLine: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 4,
    left: 0,
    position: "absolute",
    top: 8,
    width: 30
  },
  bookLeftPage: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    left: 0,
    position: "absolute",
    top: 4,
    width: 44
  },
  bookRightPage: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    height: 48,
    position: "absolute",
    right: 0,
    top: 4,
    width: 44
  },
  bookSpine: {
    backgroundColor: appColors.accent,
    borderRadius: 4,
    height: 52,
    left: 44,
    position: "absolute",
    top: 2,
    width: 8
  },
  bookWrap: {
    height: 56,
    position: "relative",
    width: 96
  },
  saveArrow: {
    height: 20,
    position: "relative",
    width: 34
  },
  saveRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    justifyContent: "center"
  },
  backdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: appColors.backdrop
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  butterDot: {
    backgroundColor: "#e9bd5a",
    borderRadius: 999,
    height: 9,
    width: 9
  },
  checkArm: {
    backgroundColor: appColors.surface,
    borderRadius: 999,
    height: 4,
    left: 17,
    position: "absolute",
    top: 10,
    transform: [{ rotate: "-48deg" }],
    width: 19
  },
  checkStem: {
    backgroundColor: appColors.surface,
    borderRadius: 999,
    height: 4,
    left: 11,
    position: "absolute",
    top: 16,
    transform: [{ rotate: "44deg" }],
    width: 12
  },
  cookLineShort: {
    backgroundColor: appColors.border,
    borderRadius: 999,
    height: 9,
    marginTop: appSpacing.md,
    width: "45%"
  },
  cookLineWide: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 9,
    width: "68%"
  },
  cookPanel: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 66,
    justifyContent: "center",
    left: "21%",
    paddingHorizontal: appSpacing.xl,
    position: "absolute",
    top: 24,
    width: "58%"
  },
  familyChip: {
    alignItems: "center",
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    left: "42%",
    position: "absolute",
    top: 77,
    width: 56
  },
  familyPlateBack: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 20,
    borderWidth: 1,
    height: 64,
    left: "27%",
    position: "absolute",
    top: 47,
    width: "30%"
  },
  familyPlateFront: {
    backgroundColor: "#cfdcd2",
    borderColor: appColors.border,
    borderRadius: 20,
    borderWidth: 1,
    height: 64,
    left: "43%",
    position: "absolute",
    top: 35,
    width: "30%"
  },
  header: {
    alignItems: "center",
    gap: appSpacing.md
  },
  overlay: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: appSpacing.lg
  },
  progress: {
    flexDirection: "row",
    gap: appSpacing.sm,
    justifyContent: "center"
  },
  progressDot: {
    backgroundColor: appColors.border,
    borderRadius: 999,
    height: 8,
    width: 8
  },
  progressDotActive: {
    backgroundColor: appColors.accent,
    width: 22
  },
  sheet: {
    gap: appSpacing.lg,
    padding: appSpacing.xl,
    zIndex: 1
  },
  title: {
    textAlign: "center"
  },
  timerLine: {
    backgroundColor: appColors.surface,
    borderRadius: 999,
    height: 6,
    width: 34
  },
  timerPill: {
    alignItems: "center",
    backgroundColor: appColors.accent,
    borderRadius: 999,
    flexDirection: "row",
    gap: appSpacing.sm,
    height: 30,
    justifyContent: "center",
    left: "34%",
    position: "absolute",
    top: 101,
    width: "32%"
  },
  urlLine: {
    backgroundColor: appColors.border,
    borderRadius: 999,
    height: 6,
    width: 44
  },
  urlPill: {
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    height: 30,
    justifyContent: "center",
    paddingHorizontal: 12,
    width: 96
  }
});
