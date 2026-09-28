import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useEffect } from "react";
import Reanimated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from "react-native-reanimated";

import { subscribeToRecipeBookBounce } from "./recipeBookBounceEvents";

import type { ComponentProps } from "react";

const BOUNCE_UP_MS = 140;
const BOUNCE_DOWN_MS = 220;

/**
 * The Cookbook tab icon. It listens for the recipe-book bounce (a recipe was just saved) and
 * gives a short hop and grow; ReduceMotion.System turns the hop off for people who ask for
 * reduced motion.
 */
export const CookbookTabIcon = ({
  color,
  name,
  size
}: {
  color: ComponentProps<typeof MaterialCommunityIcons>["color"];
  name: ComponentProps<typeof MaterialCommunityIcons>["name"];
  size: number;
}) => {
  const bounce = useSharedValue(0);

  useEffect(
    () =>
      subscribeToRecipeBookBounce(() => {
        bounce.value = 0;
        bounce.value = withSequence(
          withTiming(1, {
            duration: BOUNCE_UP_MS,
            easing: Easing.out(Easing.cubic),
            reduceMotion: ReduceMotion.System
          }),
          withTiming(0, {
            duration: BOUNCE_DOWN_MS,
            easing: Easing.bounce,
            reduceMotion: ReduceMotion.System
          })
        );
      }),
    [bounce]
  );

  const bounceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: bounce.value * -6 }, { scale: 1 + bounce.value * 0.18 }]
  }));

  return (
    <Reanimated.View style={bounceStyle} testID="cookbook-tab-icon">
      <MaterialCommunityIcons color={color} name={name} size={size} />
    </Reanimated.View>
  );
};
