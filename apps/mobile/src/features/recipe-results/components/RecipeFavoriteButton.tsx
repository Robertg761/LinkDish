import { MaterialCommunityIcons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet } from "react-native";

import { selectionTick } from "../../../lib/haptics";
import { pressedOpacity, pressedScale } from "../../../theme/interactions";
import { appColors } from "../../../theme/tokens";

/** The heart on a saved recipe: tomato when favorited, a quiet outline otherwise. */
export const RecipeFavoriteButton = ({
  favorite,
  onToggle
}: {
  favorite: boolean;
  onToggle: (favorite: boolean) => void;
}) => (
  <Pressable
    accessibilityLabel={favorite ? "Remove from favorites" : "Add to favorites"}
    accessibilityRole="button"
    accessibilityState={{ selected: favorite }}
    hitSlop={10}
    onPress={() => {
      selectionTick();
      onToggle(!favorite);
    }}
    style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    testID="recipe-favorite-button"
  >
    <MaterialCommunityIcons
      color={favorite ? appColors.tomato : appColors.muted}
      name={favorite ? "heart" : "heart-outline"}
      size={24}
    />
  </Pressable>
);

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  pressed: {
    opacity: pressedOpacity.soft,
    transform: [{ scale: pressedScale.standard }]
  }
});
