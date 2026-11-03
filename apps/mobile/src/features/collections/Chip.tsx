import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppText } from "@linkdish/ui";
import React from "react";
import { Pressable, StyleSheet } from "react-native";

import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";

import type { ComponentProps } from "react";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

/**
 * A rounded chip: a filter, a suggestion to add, or a value with a remove button. `selected`
 * fills it with the accent color.
 */
export const Chip = ({
  accessibilityLabel,
  icon,
  iconColor,
  label,
  onPress,
  selected = false,
  testID,
  trailingIcon
}: {
  accessibilityLabel?: string;
  icon?: IconName | undefined;
  iconColor?: string;
  label: string;
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  trailingIcon?: IconName | undefined;
}) => (
  <Pressable
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityRole="button"
    accessibilityState={{ selected }}
    disabled={!onPress}
    hitSlop={4}
    onPress={onPress}
    style={({ pressed }) => [
      styles.chip,
      selected && styles.chipSelected,
      pressed && onPress ? styles.pressed : null
    ]}
    testID={testID}
  >
    {icon ? (
      <MaterialCommunityIcons
        color={selected ? appColors.onAccent : (iconColor ?? appColors.accent)}
        name={icon}
        size={15}
      />
    ) : null}
    <AppText numberOfLines={1} style={[styles.label, selected && styles.labelSelected]}>
      {label}
    </AppText>
    {trailingIcon ? (
      <MaterialCommunityIcons
        color={selected ? appColors.onAccent : appColors.muted}
        name={trailingIcon}
        size={14}
      />
    ) : null}
  </Pressable>
);

const styles = StyleSheet.create({
  chip: {
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    maxWidth: 260,
    minHeight: 34,
    paddingHorizontal: appSpacing.md
  },
  chipSelected: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  label: {
    color: appColors.text,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "600"
  },
  labelSelected: {
    color: appColors.onAccent
  },
  pressed: {
    opacity: pressedOpacity.medium
  }
});
