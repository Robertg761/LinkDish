import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { appColors } from "../theme/tokens";

type AppDialogAction = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  variant?: "danger" | "ghost" | "outline" | "outline-danger" | "primary" | "secondary";
};

export const AppDialog = ({
  actions,
  message,
  onRequestClose,
  title,
  visible
}: {
  actions: AppDialogAction[];
  message: string;
  onRequestClose: () => void;
  title: string;
  visible: boolean;
}) => (
  <Modal
    animationType="fade"
    onRequestClose={onRequestClose}
    statusBarTranslucent
    transparent
    visible={visible}
  >
    <View accessibilityViewIsModal style={styles.layer}>
      <Pressable
        accessibilityLabel="Close dialog"
        accessibilityRole="button"
        onPress={onRequestClose}
        style={styles.backdrop}
      />
      <AppSurface style={styles.card}>
        <View style={styles.copy}>
          <AppText style={styles.title} variant="title">
            {title}
          </AppText>
          <AppText muted style={styles.message}>
            {message}
          </AppText>
        </View>
        <View style={styles.actions}>
          {actions.map((action) => (
            <AppButton
              disabled={action.disabled ?? false}
              key={action.label}
              label={action.label}
              onPress={action.onPress}
              style={styles.button}
              variant={action.variant ?? "primary"}
            />
          ))}
        </View>
      </AppSurface>
    </View>
  </Modal>
);

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end"
  },
  backdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(20, 28, 24, 0.52)"
  },
  button: {
    flex: 1
  },
  card: {
    borderColor: appColors.border,
    borderRadius: 24,
    borderWidth: 1,
    gap: 16,
    maxWidth: 420,
    padding: 16,
    width: "100%"
  },
  copy: {
    gap: 8
  },
  layer: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 16
  },
  message: {
    lineHeight: 22
  },
  title: {
    color: appColors.text
  }
});
