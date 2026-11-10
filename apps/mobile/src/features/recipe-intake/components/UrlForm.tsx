import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText, AppTextField } from "@linkdish/ui";
import { useEffect, useRef, useState } from "react";
import { Animated, Linking, Platform, Pressable, StyleSheet, View } from "react-native";

import { useReduceMotion } from "../../../hooks/useReduceMotion";
import { easeInOutCubic, easeOutCubic } from "../../../theme/easing";
import { pressedOpacity } from "../../../theme/interactions";
import { appColors } from "../../../theme/tokens";
import { getRecipeSourceRestriction, IOS_RECIPE_SOURCES } from "../iosRecipeSources";
import { INVALID_RECIPE_URL_MESSAGE, resolveRecipeUrlInput } from "../urlValidation";

import type { TextInputInstance } from "react-native";

interface UrlFormProps {
  disabled?: boolean;
  helperText?: string | undefined;
  onSubmit: (url: string) => void;
  resetSignal?: number;
  submitLabel?: string;
  onCameraPress?: () => void;
}

export const UrlForm = ({
  disabled = false,
  helperText,
  onSubmit,
  resetSignal = 0,
  submitLabel = "Extract recipe",
  onCameraPress
}: UrlFormProps) => {
  const reduceMotion = useReduceMotion();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInputInstance>(null);
  const inputShake = useRef(new Animated.Value(0)).current;

  const nudgeInput = () => {
    inputRef.current?.focus();
    inputShake.stopAnimation();
    inputShake.setValue(0);
    if (reduceMotion) return;
    Animated.sequence([
      Animated.timing(inputShake, {
        duration: 60,
        easing: easeOutCubic,
        toValue: 1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: easeInOutCubic,
        toValue: -1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: easeInOutCubic,
        toValue: 1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: easeOutCubic,
        toValue: 0,
        useNativeDriver: true
      })
    ]).start();
  };

  useEffect(() => {
    setUrl("");
    setError(null);
  }, [resetSignal]);

  const handleSubmit = () => {
    if (disabled) {
      return;
    }

    // A pasted caption ("so good 😍 https://…") submits the link inside it.
    const recipeUrl = resolveRecipeUrlInput(url);

    if (recipeUrl) {
      const restriction = getRecipeSourceRestriction(recipeUrl, Platform.OS);
      if (restriction) {
        setError(restriction);
        nudgeInput();
        return;
      }
      setError(null);
      onSubmit(recipeUrl);
      return;
    }

    setError(INVALID_RECIPE_URL_MESSAGE);
    nudgeInput();
  };

  const inputShakeStyle = {
    transform: [
      {
        translateX: inputShake.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-4, 0, 4]
        })
      }
    ]
  };

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.inputWrap, inputShakeStyle]}>
        <AppTextField
          onChangeText={setUrl}
          onSubmitEditing={handleSubmit}
          placeholder={
            Platform.OS === "ios"
              ? "https://publicdomainrecipes.com/basic-waffles/"
              : "https://example.com/my-recipe"
          }
          ref={inputRef}
          rightElement={
            onCameraPress ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Scan recipe"
                hitSlop={8}
                onPress={onCameraPress}
                style={({ pressed }) => [
                  styles.cameraButton,
                  pressed && styles.cameraButtonPressed
                ]}
              >
                <MaterialCommunityIcons name="camera-outline" size={22} color={appColors.accent} />
              </Pressable>
            ) : undefined
          }
          value={url}
        />
      </Animated.View>
      {error || helperText ? (
        <AppText muted style={error ? styles.errorText : undefined}>
          {error ?? helperText}
        </AppText>
      ) : null}
      {Platform.OS === "ios" ? (
        <View style={styles.sources}>
          <AppText muted>Supported recipe sources on iPhone:</AppText>
          {IOS_RECIPE_SOURCES.map(({ name, host }) => (
            <Pressable
              key={host}
              accessibilityRole="link"
              accessibilityLabel={`Browse ${name}`}
              onPress={() =>
                void Linking.openURL(`https://${host}/`).catch(() =>
                  setError(`Open https://${host}/ in your browser to choose a recipe.`)
                )
              }
            >
              <AppText tone="accent">{name} ↗</AppText>
            </Pressable>
          ))}
          <AppText muted>
            For text and photos, use material you own or have permission to use.
          </AppText>
        </View>
      ) : null}
      <AppButton
        disabled={disabled}
        label={submitLabel}
        onPress={handleSubmit}
        style={styles.submitButton}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  sources: { gap: 8 },
  container: {
    gap: 14
  },
  inputWrap: {
    minWidth: 0,
    width: "100%"
  },
  cameraButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 36,
    justifyContent: "center",
    width: 36
  },
  cameraButtonPressed: {
    opacity: pressedOpacity.strongest
  },
  errorText: {
    color: appColors.danger,
    fontSize: 14,
    lineHeight: 18,
    marginTop: -4,
    paddingHorizontal: 4
  },
  submitButton: {
    height: 50,
    minHeight: 50,
    width: "100%"
  }
});
