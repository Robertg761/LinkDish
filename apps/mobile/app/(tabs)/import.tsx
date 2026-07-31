import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppText } from "@linkdish/ui";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions
} from "react-native";

import { useAccount } from "../../src/features/account/AccountContext";
import { useBilling } from "../../src/features/billing/BillingContext";
import { UrlForm } from "../../src/features/recipe-intake/components/UrlForm";
import { subscribeToRecipeUrlReset } from "../../src/features/recipe-intake/intakeResetEvents";
import { createPendingImageImport } from "../../src/features/recipe-intake/pendingImageImports";
import { pressedOpacity } from "../../src/theme/interactions";
import { appColors, appSpacing } from "../../src/theme/tokens";

import type { ExtractRecipeImage } from "@linkdish/api-contracts";

const MAX_IMAGE_IMPORTS = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;
const MAX_IMAGE_IMPORT_PAYLOAD_LENGTH = 8_000_000;
const PAYLOAD_SIZE_CHECK_SOURCE_URL =
  "https://linkdish.app/image-imports/image-0000000000000-00000000";
const IMAGE_TOO_LARGE_MESSAGE =
  "That image was too large or could not be read. Try a clearer photo.";
const HERO_ENTRANCE_DURATION_MS = 340;
const HERO_ENTRANCE_DELAYS_MS = [0, 70, 140, 240] as const;

export default function HomeScreen() {
  const { canStartImport } = useBilling();
  const { isSignedIn } = useAccount();
  const { height: windowHeight } = useWindowDimensions();
  const [imageScanError, setImageScanError] = useState<string | null>(null);
  const [isStartingImageImport, setIsStartingImageImport] = useState(false);
  const [urlResetSignal, setUrlResetSignal] = useState(0);
  const [isScanSheetVisible, setIsScanSheetVisible] = useState(false);
  const [isScanSheetRendered, setIsScanSheetRendered] = useState(false);
  const sheetProgress = React.useRef(new Animated.Value(0)).current;
  const heroEntranceValues = React.useRef(
    HERO_ENTRANCE_DELAYS_MS.map(() => new Animated.Value(0))
  ).current;
  const useServerBillingGate = isSignedIn;
  const importGate = useServerBillingGate ? { allowed: true } : canStartImport();

  useEffect(() => {
    heroEntranceValues.forEach((value, index) => {
      Animated.timing(value, {
        delay: HERO_ENTRANCE_DELAYS_MS[index],
        duration: HERO_ENTRANCE_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true
      }).start();
    });

    return () => {
      heroEntranceValues.forEach((value) => {
        value.stopAnimation?.();
      });
    };
  }, [heroEntranceValues]);

  const getHeroEntranceStyle = (index: number) => {
    const value = heroEntranceValues[index] ?? heroEntranceValues[0]!;

    return {
      opacity: value,
      transform: [
        {
          translateY: value.interpolate({
            inputRange: [0, 1],
            outputRange: [10, 0]
          })
        }
      ]
    };
  };

  useEffect(
    () =>
      subscribeToRecipeUrlReset(() => {
        setUrlResetSignal((current) => current + 1);
      }),
    []
  );

  const handleSubmit = (url: string) => {
    if (!useServerBillingGate && !importGate.allowed) {
      router.push("/upgrade" as never);
      return;
    }

    router.push({
      pathname: "/recipe",
      params: {
        url
      }
    });
  };

  const routeToImageImport = (images: ExtractRecipeImage[]) => {
    const pendingImport = createPendingImageImport(images);

    router.push({
      pathname: "/recipe",
      params: {
        imageImportId: pendingImport.id,
        url: pendingImport.sourceUrl
      }
    });
  };

  const getImageImportsFromAssets = (
    assets: ImagePicker.ImagePickerAsset[]
  ): ExtractRecipeImage[] => {
    const imageImports = assets
      .slice(0, MAX_IMAGE_IMPORTS)
      .map((asset) => {
        const base64 = asset.base64?.trim();
        const mimeType =
          asset.mimeType === "image/png" || asset.mimeType === "image/webp"
            ? asset.mimeType
            : "image/jpeg";

        if (!base64) {
          return null;
        }

        const dataUrl = `data:${mimeType};base64,${base64}`;

        if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
          return null;
        }

        return {
          dataUrl,
          mimeType
        };
      })
      .filter((image): image is ExtractRecipeImage => image !== null);

    return imageImports;
  };

  const isImageImportPayloadTooLarge = (images: ExtractRecipeImage[]) =>
    JSON.stringify({
      images,
      sourceUrl: PAYLOAD_SIZE_CHECK_SOURCE_URL,
      attempt: "fallback"
    }).length > MAX_IMAGE_IMPORT_PAYLOAD_LENGTH;

  const startImageImport = async (source: "camera" | "library") => {
    if (isStartingImageImport) {
      return;
    }

    if (!useServerBillingGate && !importGate.allowed) {
      router.push("/upgrade" as never);
      return;
    }

    setImageScanError(null);
    setIsStartingImageImport(true);

    try {
      if (source === "camera") {
        const permission = (await ImagePicker.requestCameraPermissionsAsync()) as unknown;
        const hasPermission =
          typeof permission === "object" &&
          permission !== null &&
          "granted" in permission &&
          permission.granted === true;

        if (!hasPermission) {
          setImageScanError("Camera access is needed to scan a recipe from paper.");
          return;
        }
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({
              base64: true,
              mediaTypes: ["images"],
              quality: 0.72
            })
          : await ImagePicker.launchImageLibraryAsync({
              allowsMultipleSelection: true,
              base64: true,
              mediaTypes: ["images"],
              orderedSelection: true,
              quality: 0.72,
              selectionLimit: MAX_IMAGE_IMPORTS
            });

      if (result.canceled) {
        return;
      }

      const images = getImageImportsFromAssets(result.assets);

      if (images.length === 0 || isImageImportPayloadTooLarge(images)) {
        setImageScanError(IMAGE_TOO_LARGE_MESSAGE);
        return;
      }

      routeToImageImport(images);
    } catch (error) {
      console.warn("Failed to start image recipe import.", error);
      setImageScanError("LinkDish could not open image scanning. Try again.");
    } finally {
      setIsStartingImageImport(false);
    }
  };

  const handleCameraPress = () => {
    setIsScanSheetRendered(true);
    setIsScanSheetVisible(true);
  };

  const closeScanSheet = () => {
    setIsScanSheetVisible(false);
    Animated.timing(sheetProgress, {
      toValue: 0,
      duration: 220,
      easing: Easing.bezier(0.25, 1, 0.5, 1),
      useNativeDriver: true
    }).start(({ finished }) => {
      if (finished) {
        setIsScanSheetRendered(false);
      }
    });
  };

  useEffect(() => {
    if (isScanSheetVisible) {
      Animated.timing(sheetProgress, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }).start();
    }
  }, [isScanSheetVisible]);

  return (
    <View style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.keyboardAvoiding}
      >
        <ScrollView
          contentContainerStyle={[
            styles.container,
            { paddingBottom: appSpacing.xxl + windowHeight * 0.12 }
          ]}
          keyboardDismissMode={Platform.OS === "ios" ? "on-drag" : "none"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Animated.View style={getHeroEntranceStyle(0)}>
              <AppText style={styles.heroEyebrow} tone="accent" variant="label">
                LINKDISH
              </AppText>
            </Animated.View>
            <View style={styles.heroLockup}>
              <Animated.View style={getHeroEntranceStyle(1)}>
                <AppText style={styles.title} variant="display">
                  Paste a link.
                </AppText>
              </Animated.View>
              <Animated.View style={getHeroEntranceStyle(2)}>
                <AppText italic style={styles.title} tone="accent" variant="display">
                  Get cooking.
                </AppText>
              </Animated.View>
            </View>
          </View>

          <Animated.View style={[styles.formContainer, getHeroEntranceStyle(3)]}>
            <UrlForm
              disabled={false}
              helperText={
                !useServerBillingGate && !importGate.allowed ? importGate.message : undefined
              }
              onSubmit={handleSubmit}
              resetSignal={urlResetSignal}
              onCameraPress={handleCameraPress}
            />
          </Animated.View>

          {imageScanError || (!useServerBillingGate && !importGate.allowed) ? (
            <View style={styles.errorContainer}>
              <AppText muted style={imageScanError ? styles.scanErrorText : undefined}>
                {imageScanError ?? importGate.message}
              </AppText>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
      <ScanOptionsSheet
        visible={isScanSheetRendered}
        onClose={closeScanSheet}
        onSelectOption={(option) => {
          void startImageImport(option);
        }}
        progress={sheetProgress}
      />
    </View>
  );
}

interface ScanOptionsSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelectOption: (option: "camera" | "library") => void;
  progress: Animated.Value;
}

const ScanOptionsSheet = ({
  visible,
  onClose,
  onSelectOption,
  progress
}: ScanOptionsSheetProps) => {
  const { width: windowWidth } = useWindowDimensions();

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-8, 0]
  });

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0]
  });

  const scaleX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.985, 1]
  });

  const scaleY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.985, 1]
  });

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.backdropPressable} onPress={onClose}>
        <Animated.View
          style={[
            styles.sheetBackdrop,
            {
              opacity: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1]
              })
            }
          ]}
        />
        <View style={styles.sheetLayoutWrapper} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.sheetContainer,
              {
                opacity: progress.interpolate({
                  inputRange: [0, 0.18, 1],
                  outputRange: [0, 0.82, 1]
                }),
                transform: [{ translateX }, { translateY }, { scaleX }, { scaleY }],
                width: Math.min(windowWidth - 28, 480)
              }
            ]}
          >
            <Pressable style={styles.sheetContent} pointerEvents="box-none">
              <AppText style={styles.sheetTitle} tone="accent" variant="label">
                Scan Recipe
              </AppText>

              <Pressable
                style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
                onPress={() => {
                  onClose();
                  onSelectOption("camera");
                }}
              >
                <View style={styles.sheetIconBox}>
                  <MaterialCommunityIcons
                    name="camera-outline"
                    size={24}
                    color={appColors.accent}
                  />
                </View>
                <View style={styles.sheetRowText}>
                  <AppText style={styles.sheetRowTitle} variant="title">
                    Take Photo
                  </AppText>
                  <AppText style={styles.sheetRowDesc} muted>
                    Scan physical cookbooks or paper
                  </AppText>
                </View>
              </Pressable>

              <Pressable
                style={({ pressed }) => [styles.sheetRow, pressed && styles.sheetRowPressed]}
                onPress={() => {
                  onClose();
                  onSelectOption("library");
                }}
              >
                <View style={styles.sheetIconBox}>
                  <MaterialCommunityIcons
                    name="image-multiple-outline"
                    size={24}
                    color={appColors.accent}
                  />
                </View>
                <View style={styles.sheetRowText}>
                  <AppText style={styles.sheetRowTitle} variant="title">
                    Choose from Gallery
                  </AppText>
                  <AppText style={styles.sheetRowDesc} muted>
                    Select saved screenshot or photo
                  </AppText>
                </View>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.sheetCancelButton,
                  pressed && styles.sheetCancelButtonPressed
                ]}
                onPress={onClose}
              >
                <AppText style={styles.sheetCancelText}>Cancel</AppText>
              </Pressable>
            </Pressable>
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: appColors.background,
    flexGrow: 1,
    justifyContent: "center",
    padding: appSpacing.xxl
  },
  formContainer: {
    alignSelf: "center",
    marginBottom: appSpacing.xxxl,
    maxWidth: 680,
    width: "100%"
  },
  header: {
    alignItems: "center",
    alignSelf: "center",
    marginBottom: appSpacing.xl,
    marginTop: appSpacing.xxl,
    maxWidth: 680,
    width: "100%"
  },
  heroEyebrow: {
    fontWeight: "600",
    letterSpacing: 2,
    marginBottom: appSpacing.md
  },
  heroLockup: {
    alignItems: "center"
  },
  keyboardAvoiding: {
    flex: 1
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  errorContainer: {
    alignSelf: "center",
    marginTop: appSpacing.md,
    maxWidth: 680,
    width: "100%"
  },
  scanErrorText: {
    color: appColors.danger,
    fontSize: 14,
    lineHeight: 18
  },
  title: {
    lineHeight: 48,
    textAlign: "center"
  },
  sheetBackdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: appColors.backdrop
  },
  sheetContainer: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    padding: appSpacing.xxl,
    gap: appSpacing.lg,
    shadowColor: appColors.shadow,
    shadowOffset: { height: 10, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: Platform.OS === "android" ? 4 : 0
  },
  sheetContent: {
    gap: appSpacing.lg
  },
  sheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: appColors.border,
    alignSelf: "center",
    marginBottom: appSpacing.sm
  },
  sheetTitle: {
    marginBottom: appSpacing.xs,
    textAlign: "center"
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: appSpacing.lg,
    gap: 14,
    shadowColor: appColors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1
  },
  sheetRowPressed: {
    opacity: pressedOpacity.medium,
    backgroundColor: appColors.surfaceMuted,
    transform: [{ scale: 0.99 }]
  },
  sheetIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: appColors.accentSoft,
    alignItems: "center",
    justifyContent: "center"
  },
  sheetRowText: {
    flex: 1,
    gap: 2
  },
  sheetRowTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: appColors.text
  },
  sheetRowDesc: {
    fontSize: 12,
    lineHeight: 16,
    color: appColors.muted
  },
  sheetCancelButton: {
    backgroundColor: "transparent",
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: appSpacing.sm
  },
  sheetCancelButtonPressed: {
    opacity: pressedOpacity.medium
  },
  sheetCancelText: {
    color: appColors.accent,
    fontSize: 15,
    fontWeight: "700"
  },
  backdropPressable: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0
  },
  sheetLayoutWrapper: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    justifyContent: "center",
    alignItems: "center",
    padding: 14
  }
});
