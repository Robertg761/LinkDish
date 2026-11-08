import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useLayoutEffect, useRef, useState } from "react";
import { Alert, Linking, Modal, ScrollView, StyleSheet, View } from "react-native";

import { appColors } from "../../theme/tokens";

import {
  AI_CONSENT_STORAGE_KEY,
  createAiConsentController,
  registerAiConsentHandler
} from "./ai-consent";

export const AiConsentGate = ({ blocked = false }: { blocked?: boolean }) => {
  const [visible, setVisible] = useState(false);
  const resolvePrompt = useRef<((allowed: boolean) => void) | undefined>(undefined);

  useLayoutEffect(() => {
    let mounted = true;
    const unregister = registerAiConsentHandler(
      createAiConsentController({
        read: () => AsyncStorage.getItem(AI_CONSENT_STORAGE_KEY),
        write: (value) => AsyncStorage.setItem(AI_CONSENT_STORAGE_KEY, value),
        prompt: () =>
          new Promise<boolean>((resolve) => {
            if (!mounted) {
              resolve(false);
              return;
            }
            resolvePrompt.current = resolve;
            setVisible(true);
          })
      })
    );
    return () => {
      mounted = false;
      unregister();
      resolvePrompt.current?.(false);
      resolvePrompt.current = undefined;
    };
  }, []);

  const finish = (allowed: boolean) => {
    setVisible(false);
    resolvePrompt.current?.(allowed);
    resolvePrompt.current = undefined;
  };

  return (
    <Modal
      visible={visible && !blocked}
      transparent
      animationType="fade"
      onRequestClose={() => finish(false)}
    >
      <View style={styles.overlay} accessibilityViewIsModal>
        <AppSurface style={styles.card}>
          <ScrollView contentContainerStyle={styles.content}>
            <AppText variant="title">Allow Gemini processing?</AppText>
            <AppText>
              To import or complete a recipe, LinkDish sends the content you submit to its server.
              Recipe photos, pasted text, recipe details, and content from submitted links may then
              be shared with Google Gemini, a third-party AI service, to read recipes or fill in
              missing details.
            </AppText>
            <AppText muted>
              Only submit content you want processed. AI can make mistakes; check ingredients,
              quantities, and cooking instructions before using the result.
            </AppText>
            <AppText muted>
              Your choice is remembered on this device. Change it anytime under AI data sharing in
              Account. You can still view saved recipes without allowing AI processing.
            </AppText>
            <AppButton
              label="Privacy policy"
              variant="ghost"
              onPress={() => {
                void Linking.openURL("https://linkdish.ca/privacy/").catch(() => {
                  Alert.alert(
                    "Unable to open privacy policy",
                    "Visit https://linkdish.ca/privacy/ in your browser."
                  );
                });
              }}
            />
            <AppButton label="Allow and continue" onPress={() => finish(true)} />
            <AppButton label="Don't allow" variant="secondary" onPress={() => finish(false)} />
          </ScrollView>
        </AppSurface>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "rgba(20, 28, 24, 0.52)"
  },
  card: {
    maxWidth: 480,
    maxHeight: "90%",
    width: "100%",
    borderColor: appColors.border,
    padding: 20
  },
  content: { gap: 16 }
});
