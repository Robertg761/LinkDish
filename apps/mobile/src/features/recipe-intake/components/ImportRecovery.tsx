import { MAX_IMAGE_EXTRACT_COUNT } from "@linkdish/api-contracts";
import { AppButton, AppText } from "@linkdish/ui";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { appColors } from "../../../theme/tokens";
import { createPendingImageImport } from "../pendingImageImports";
import { preparePickedImages } from "../preparePickedImages";

import { UrlForm } from "./UrlForm";

// Changing the source cannot resolve account, consent, quota, or connectivity problems.
export const shouldOfferImportAlternative = (reason: string) =>
  [
    "unsupported_source",
    "source_unreachable",
    "source_blocked",
    "parse_failed",
    "fallback_failed",
    "low_confidence",
    "missing_required_fields",
    "transcript_required",
    "unsupported_primary_extraction"
  ].includes(reason);

export const ImportRecovery = ({ source }: { source: "url" | "image" | "text" }) => {
  const [busy, setBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const picking = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pickPhotos = async (from: "library" | "camera") => {
    if (picking.current) return;
    picking.current = true;
    setBusy(true);
    setPickerError(null);
    try {
      if (from === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!mounted.current) return;
        if (!permission.granted) {
          setPickerError(
            "Camera access is off. Choose a recipe photo from your library or paste a link below."
          );
          return;
        }
      }
      const result =
        from === "camera"
          ? await ImagePicker.launchCameraAsync({
              base64: false,
              mediaTypes: ["images"],
              quality: 0.72
            })
          : await ImagePicker.launchImageLibraryAsync({
              allowsMultipleSelection: true,
              base64: false,
              mediaTypes: ["images"],
              orderedSelection: true,
              quality: 0.72,
              selectionLimit: MAX_IMAGE_EXTRACT_COUNT
            });
      if (result.canceled || !mounted.current) return;
      const images = await preparePickedImages(result.assets);
      if (!mounted.current) return;
      const pending = createPendingImageImport(images);
      router.replace({
        pathname: "/recipe",
        params: { imageImportId: pending.id, url: pending.sourceUrl }
      });
    } catch {
      if (mounted.current)
        setPickerError(
          "Those photos could not be opened or prepared. Try a smaller photo, or paste a recipe link below."
        );
    } finally {
      picking.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View style={styles.callout}>
      <AppText variant="title">
        {source === "url" ? "Try a recipe photo instead" : "Try the recipe link instead"}
      </AppText>
      <AppText>
        {source === "url"
          ? "Some sites block access or leave out recipe details. Upload a screenshot or photo showing the ingredients and steps, or take a photo now."
          : source === "image"
            ? "The photo may not show enough readable recipe details. Paste the original recipe link here to try another way."
            : "If the pasted text is incomplete, try the original recipe link here."}
      </AppText>
      {source === "url" ? (
        <View style={styles.actions}>
          <AppButton
            disabled={busy}
            label={busy ? "Preparing photo…" : "Upload recipe photo"}
            onPress={() => void pickPhotos("library")}
          />
          <AppButton
            disabled={busy}
            label="Take a photo"
            variant="secondary"
            onPress={() => void pickPhotos("camera")}
          />
        </View>
      ) : null}
      {pickerError ? <AppText>{pickerError}</AppText> : null}
      {source !== "url" || pickerError ? (
        <UrlForm
          disabled={busy}
          onSubmit={(url) => router.replace({ pathname: "/recipe", params: { url } })}
          submitLabel="Try recipe link"
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  callout: {
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.accent,
    borderLeftWidth: 4,
    borderRadius: 16,
    padding: 16,
    gap: 12
  },
  actions: { gap: 8 }
});
