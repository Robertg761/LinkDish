import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText, AppTextField } from "@linkdish/ui";
import { toTrimmedOrNull } from "@linkdish/utils";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";

import { pressedOpacity } from "../../../theme/interactions";
import { appColors } from "../../../theme/tokens";
import { INVALID_RECIPE_URL_MESSAGE, isAllowedRecipeUrl } from "../urlValidation";

import type { TextInput } from "react-native";

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
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  const inputShake = useRef(new Animated.Value(0)).current;

  const nudgeInput = () => {
    inputRef.current?.focus();
    inputShake.stopAnimation();
    inputShake.setValue(0);
    Animated.sequence([
      Animated.timing(inputShake, {
        duration: 60,
        easing: Easing.out(Easing.cubic),
        toValue: 1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: Easing.inOut(Easing.cubic),
        toValue: -1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: Easing.inOut(Easing.cubic),
        toValue: 1,
        useNativeDriver: true
      }),
      Animated.timing(inputShake, {
        duration: 60,
        easing: Easing.out(Easing.cubic),
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

    const trimmedUrl = toTrimmedOrNull(url);

    if (trimmedUrl && isAllowedRecipeUrl(trimmedUrl)) {
      setError(null);
      onSubmit(trimmedUrl);
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
          placeholder="https://example.com/my-recipe"
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
