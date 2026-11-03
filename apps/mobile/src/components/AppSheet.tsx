import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppText } from "@linkdish/ui";
import React, { type PropsWithChildren, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { pressedOpacity } from "../theme/interactions";
import { appColors, appSpacing } from "../theme/tokens";

interface AppSheetProps extends PropsWithChildren {
  /** A line under the title (the recipe a sheet is about). */
  description?: string | undefined;
  /** Pinned under the scrolling body (the sheet's main button). */
  footer?: ReactNode;
  onClose: () => void;
  testID?: string;
  title: string;
  visible: boolean;
}

/**
 * A bottom sheet: a titled card that slides up over a dimmed backdrop, with a scrolling body and
 * an optional pinned footer. Tapping the backdrop, the close button or Back closes it.
 */
export const AppSheet = ({
  children,
  description,
  footer,
  onClose,
  testID,
  title,
  visible
}: AppSheetProps) => {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.layer}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, appSpacing.lg) }]}
          testID={testID}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <AppText variant="title">{title}</AppText>
              {description ? (
                <AppText muted numberOfLines={2} style={styles.description}>
                  {description}
                </AppText>
              ) : null}
            </View>
            <Pressable
              accessibilityLabel={`Close ${title}`}
              accessibilityRole="button"
              hitSlop={10}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <MaterialCommunityIcons color={appColors.muted} name="close" size={22} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            style={styles.scroll}
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
    backgroundColor: appColors.backdrop
  },
  body: {
    gap: appSpacing.lg,
    paddingBottom: appSpacing.md,
    paddingHorizontal: appSpacing.xl
  },
  closeButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  description: {
    fontSize: 14,
    lineHeight: 19
  },
  footer: {
    gap: appSpacing.sm,
    paddingHorizontal: appSpacing.xl,
    paddingTop: appSpacing.md
  },
  handle: {
    alignSelf: "center",
    backgroundColor: appColors.border,
    borderRadius: 2,
    height: 4,
    marginBottom: appSpacing.sm,
    width: 38
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: appSpacing.md,
    paddingBottom: appSpacing.md,
    paddingHorizontal: appSpacing.xl
  },
  headerCopy: {
    flex: 1,
    gap: 2
  },
  layer: {
    flex: 1,
    justifyContent: "flex-end"
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  scroll: {
    flexGrow: 0
  },
  sheet: {
    alignSelf: "center",
    backgroundColor: appColors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "88%",
    maxWidth: 680,
    paddingTop: appSpacing.sm,
    width: "100%"
  }
});
