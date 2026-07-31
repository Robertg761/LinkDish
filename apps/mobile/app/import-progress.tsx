import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, StyleSheet, View } from "react-native";

import { trackMobileEvent } from "../src/analytics/client";
import { useOptionalUpgradeMoment } from "../src/features/billing/UpgradeMomentContext";
import { createPendingImageImport } from "../src/features/recipe-intake/pendingImageImports";
import { prepareSharedImageImport } from "../src/features/recipe-intake/sharedImageImport";
import { extractUrlFromSharedText } from "../src/features/recipe-intake/sharedText";
import { useRecipeExtraction } from "../src/features/recipe-results/hooks/useRecipeExtraction";
import { EXTRACTION_ERROR_LINES, selectFlavorCopyLine } from "../src/theme/flavorCopy";
import { appColors, appSpacing } from "../src/theme/tokens";

const EXTRACTION_LOADING_COPY = [
  "Plating your recipe...",
  "Skimming off the ads...",
  "Chopping it down to the good stuff...",
  "Tasting for seasoning...",
  "Setting the table..."
] as const;

const EXTRACTION_COPY_INTERVAL_MS = 1800;
const EXTRACTION_COPY_SWAP_MS = 250;

const readFirstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const LoadingCopy = () => {
  const [copyIndex, setCopyIndex] = useState(0);
  const copyProgress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(copyProgress, {
        duration: EXTRACTION_COPY_SWAP_MS,
        toValue: 1,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!finished) {
          return;
        }

        setCopyIndex((current) => (current + 1) % EXTRACTION_LOADING_COPY.length);
        copyProgress.setValue(-1);
        Animated.timing(copyProgress, {
          duration: EXTRACTION_COPY_SWAP_MS,
          toValue: 0,
          useNativeDriver: true
        }).start();
      });
    }, EXTRACTION_COPY_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      copyProgress.stopAnimation();
    };
  }, [copyProgress]);

  return (
    <Animated.View
      style={{
        opacity: copyProgress.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [0, 1, 0]
        }),
        transform: [
          {
            translateY: copyProgress.interpolate({
              inputRange: [-1, 0, 1],
              outputRange: [8, 0, -8]
            })
          }
        ]
      }}
    >
      <AppText muted style={styles.loadingLine}>
        {EXTRACTION_LOADING_COPY[copyIndex]}
      </AppText>
    </Animated.View>
  );
};

export default function ImportProgressScreen() {
  const params = useLocalSearchParams<{
    imageUri?: string | string[];
    mimeType?: string | string[];
    text?: string | string[];
    url?: string | string[];
  }>();
  const { showUpgradeMoment } = useOptionalUpgradeMoment();
  const extractionErrorTitle = useMemo(() => selectFlavorCopyLine(EXTRACTION_ERROR_LINES), []);
  const sharedImageUri = readFirstParam(params.imageUri);
  const sharedImageMimeType = readFirstParam(params.mimeType);
  const preparedImageUriRef = useRef<string | undefined>(undefined);
  const [sharedImageError, setSharedImageError] = useState<string | null>(null);
  const sharedUrl = useMemo(() => {
    const urlParam = readFirstParam(params.url);
    const textParam = readFirstParam(params.text);
    return urlParam ?? extractUrlFromSharedText(textParam);
  }, [params.text, params.url]);
  const extraction = useRecipeExtraction(sharedUrl, undefined, {
    importSource: "share_sheet",
    routeOrScreen: "import-progress"
  });

  useEffect(() => {
    if (!sharedImageUri || preparedImageUriRef.current === sharedImageUri) {
      return;
    }

    preparedImageUriRef.current = sharedImageUri;
    setSharedImageError(null);
    let cancelled = false;

    trackMobileEvent({
      eventName: "android_image_import_started",
      routeOrScreen: "import-progress",
      properties: {
        source: "share_sheet"
      }
    });

    void prepareSharedImageImport(sharedImageUri, sharedImageMimeType)
      .then((image) => {
        if (cancelled) {
          return;
        }

        const pendingImport = createPendingImageImport([image]);
        trackMobileEvent({
          eventName: "android_image_import_submitted",
          routeOrScreen: "import-progress",
          properties: {
            image_count: 1,
            source: "share_sheet"
          }
        });
        router.replace({
          pathname: "/recipe",
          params: {
            imageImportId: pendingImport.id,
            url: pendingImport.sourceUrl
          }
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }

        console.warn("Failed to prepare shared recipe image.", error);
        setSharedImageError(
          error instanceof Error && error.message.includes("too large")
            ? "That image is too large to scan. Choose a smaller image from your gallery."
            : "LinkDish could not read that shared image. Choose it from your gallery instead."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [sharedImageMimeType, sharedImageUri]);

  useEffect(() => {
    if (extraction.state.state === "success") {
      router.replace({
        pathname: "/recipe",
        params: {
          url: extraction.state.recipe.sourceUrl
        }
      });
    }
  }, [extraction.state]);

  useEffect(() => {
    if (
      extraction.state.state === "failure" &&
      (extraction.state.reason === "plan_limit" || extraction.state.reason === "quota_exceeded")
    ) {
      showUpgradeMoment("share_sheet_quota_exceeded");
    }
  }, [extraction.state, showUpgradeMoment]);

  const retry =
    extraction.state.state === "failure" && extraction.state.suggestedAction === "retry_primary"
      ? extraction.retryPrimary
      : extraction.retryWithFallback;
  const failureMessage =
    sharedImageError ??
    (extraction.state.state === "failure"
      ? extraction.state.message
      : "LinkDish could not find a recipe link in that share.");
  const isPreparingSharedImage = Boolean(sharedImageUri) && !sharedImageError;

  return (
    <View style={styles.screen}>
      <AppSurface style={styles.card}>
        {isPreparingSharedImage ||
        ((extraction.state.state === "loading" || extraction.state.state === "empty") &&
          sharedUrl) ? (
          <>
            <View style={styles.iconWrap}>
              <ActivityIndicator color={appColors.accent} />
            </View>
            <View style={styles.copy}>
              <AppText style={styles.title} variant="headline">
                Plating...
              </AppText>
              <LoadingCopy />
            </View>
          </>
        ) : null}

        {sharedImageError ||
        extraction.state.state === "failure" ||
        (!sharedUrl && !sharedImageUri) ? (
          <>
            <View style={styles.iconWrap}>
              <MaterialCommunityIcons
                color={appColors.accent}
                name="silverware-fork-knife"
                size={28}
              />
            </View>
            <View style={styles.copy}>
              <AppText style={styles.title} variant="headline">
                {extractionErrorTitle}
              </AppText>
              <AppText muted style={styles.body}>
                {failureMessage}
              </AppText>
            </View>
            <View style={styles.actions}>
              {sharedUrl ? <AppButton label="Retry" onPress={retry} /> : null}
              <AppButton
                label="Import manually"
                onPress={() => router.replace("/import" as never)}
                variant={sharedUrl ? "secondary" : "primary"}
              />
            </View>
          </>
        ) : null}
      </AppSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: appSpacing.sm,
    width: "100%"
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  card: {
    alignItems: "center",
    gap: appSpacing.lg,
    padding: appSpacing.xl,
    width: "100%"
  },
  copy: {
    alignItems: "center",
    gap: appSpacing.sm
  },
  iconWrap: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 58,
    justifyContent: "center",
    width: 58
  },
  loadingLine: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center"
  },
  screen: {
    alignItems: "center",
    backgroundColor: appColors.background,
    flex: 1,
    justifyContent: "center",
    padding: appSpacing.lg
  },
  title: {
    color: appColors.text,
    textAlign: "center"
  }
});
