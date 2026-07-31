import { createContext, forwardRef, useContext, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { PropsWithChildren, ReactNode } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";

type SerifFontVoice = "bold" | "italic" | "semibold";

const fallbackSerifFontFamily = Platform.OS === "android" ? "serif" : "Georgia";

const frauncesFontFamilies: Record<SerifFontVoice, string> = {
  bold: "Fraunces-Bold",
  italic: "Fraunces-SemiBoldItalic",
  semibold: "Fraunces-SemiBold"
};

interface AppFontContextValue {
  useFrauncesSerif: boolean;
}

const AppFontContext = createContext<AppFontContextValue>({ useFrauncesSerif: true });

export const AppFontProvider = ({
  children,
  useFrauncesSerif = true
}: PropsWithChildren<{ useFrauncesSerif?: boolean }>) => (
  <AppFontContext.Provider value={{ useFrauncesSerif }}>{children}</AppFontContext.Provider>
);

export const getAppSerifFontFamily = (
  voice: SerifFontVoice = "semibold",
  useFrauncesSerif = true
): string => {
  if (!useFrauncesSerif) {
    return fallbackSerifFontFamily;
  }

  if (Platform.OS === "web") {
    return `${frauncesFontFamilies[voice]}, Georgia, serif`;
  }

  return frauncesFontFamilies[voice];
};

export const appColors = {
  background: "#f4efe7",
  canvas: "#fbf7f0",
  surface: "#fffdf8",
  surfaceMuted: "#efe7da",
  border: "#ddd2c3",
  accent: "#29443b",
  accentSoft: "#dde7df",
  text: "#1f211d",
  muted: "#6e685f",
  danger: "#9a523f",
  dangerText: "#8b2e23",
  shadow: "#5d564b",
  backdrop: "rgba(31, 33, 29, 0.4)",
  backdropLight: "rgba(31, 33, 29, 0.1)",
  placeholder: "rgba(110, 104, 95, 0.6)"
} as const;

export const appSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32
} as const;

export const appShadows = {
  soft: {
    shadowColor: appColors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 2
  },
  premium: {
    shadowColor: appColors.shadow,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 5
  }
} as const;

interface AppTextProps extends PropsWithChildren {
  italic?: boolean;
  muted?: boolean;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  tone?: "accent" | "default" | "muted";
  variant?: "body" | "display" | "headline" | "label" | "title";
}

export const AppText = ({
  children,
  italic = false,
  muted = false,
  numberOfLines,
  style,
  tone = "default",
  variant = "body"
}: AppTextProps) => {
  const { useFrauncesSerif } = useContext(AppFontContext);
  const serifStyle =
    variant === "display" || variant === "headline"
      ? {
          fontFamily: getAppSerifFontFamily("semibold", useFrauncesSerif),
          fontWeight: "400" as const
        }
      : variant === "title"
        ? {
            fontFamily: getAppSerifFontFamily("bold", useFrauncesSerif),
            fontWeight: useFrauncesSerif ? ("400" as const) : ("700" as const)
          }
        : null;
  const italicStyle = italic
    ? {
        fontFamily: getAppSerifFontFamily("italic", useFrauncesSerif),
        fontStyle: useFrauncesSerif ? ("normal" as const) : ("italic" as const),
        fontWeight: "400" as const
      }
    : null;

  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        styles.text,
        variant === "display" && styles.display,
        variant === "headline" && styles.headline,
        variant === "label" && styles.label,
        variant === "title" && styles.title,
        serifStyle,
        tone === "accent" && styles.accentText,
        tone === "muted" && styles.mutedText,
        italicStyle,
        style,
        muted && styles.mutedText
      ]}
    >
      {children}
    </Text>
  );
};

interface AppSurfaceProps extends PropsWithChildren {
  style?: StyleProp<ViewStyle>;
  tone?: "default" | "subtle";
}

export const AppSurface = ({ children, style, tone = "default" }: AppSurfaceProps) => (
  <View style={[styles.surface, tone === "subtle" && styles.surfaceSubtle, style]}>{children}</View>
);

interface AppButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: "danger" | "ghost" | "outline" | "outline-danger" | "primary" | "secondary";
}

export const AppButton = ({
  label,
  onPress,
  disabled = false,
  style,
  variant = "primary"
}: AppButtonProps) => {
  const usesMutedDisabledTreatment = disabled && (variant === "primary" || variant === "secondary");

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        variant === "outline" && styles.buttonOutline,
        variant === "outline-danger" && styles.buttonOutlineDanger,
        variant === "ghost" && styles.buttonGhost,
        style,
        usesMutedDisabledTreatment && styles.buttonDisabledMuted,
        pressed && !disabled && variant === "outline" && styles.buttonOutlinePressed,
        pressed && !disabled && variant === "outline-danger" && styles.buttonOutlineDangerPressed,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === "secondary" && styles.buttonTextSecondary,
          variant === "danger" && styles.buttonTextDanger,
          variant === "outline" && styles.buttonTextOutline,
          variant === "outline-danger" && styles.buttonTextOutlineDanger,
          variant === "ghost" && styles.buttonTextGhost,
          usesMutedDisabledTreatment && styles.buttonTextDisabledMuted
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
};

interface AppTextFieldProps {
  onChangeText: (value: string) => void;
  onSubmitEditing?: () => void;
  placeholder?: string;
  rightElement?: ReactNode;
  value: string;
}

export const AppTextField = forwardRef<TextInput, AppTextFieldProps>(
  ({ value, placeholder, onChangeText, onSubmitEditing, rightElement }, ref) => {
    const [isFocused, setIsFocused] = useState(false);
    return (
      <View style={[styles.inputContainer, isFocused && styles.inputFocused]}>
        <TextInput
          autoComplete="url"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={onChangeText}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onSubmitEditing={onSubmitEditing}
          placeholder={placeholder}
          placeholderTextColor={appColors.placeholder}
          ref={ref}
          returnKeyType="go"
          style={styles.input}
          textContentType="URL"
          value={value}
        />
        {rightElement ? <View style={styles.inputRightElement}>{rightElement}</View> : null}
      </View>
    );
  }
);

AppTextField.displayName = "AppTextField";

export const AppChip = ({
  label,
  tone = "default"
}: {
  label: string;
  tone?: "accent" | "default";
}) => (
  <View style={[styles.chip, tone === "accent" && styles.chipAccent]}>
    <Text style={[styles.chipText, tone === "accent" && styles.chipTextAccent]}>{label}</Text>
  </View>
);

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: appColors.accent,
    borderRadius: 12,
    borderColor: appColors.accent,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 22,
    shadowColor: appColors.accent,
    shadowOffset: {
      width: 0,
      height: 4
    },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: Platform.OS === "android" ? 1 : 0
  },
  buttonDisabledMuted: {
    backgroundColor: appColors.surfaceMuted,
    shadowOpacity: 0,
    elevation: 0
  },
  buttonDanger: {
    backgroundColor: "#f2d8d2",
    borderColor: "#e1b2a9",
    shadowOpacity: 0,
    elevation: 0
  },
  buttonGhost: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    minHeight: 42,
    paddingHorizontal: 0,
    shadowOpacity: 0,
    elevation: 0
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }]
  },
  buttonOutline: {
    backgroundColor: "transparent",
    borderColor: appColors.border,
    shadowOpacity: 0,
    elevation: 0
  },
  buttonOutlineDanger: {
    backgroundColor: "transparent",
    borderColor: "rgba(154, 82, 63, 0.42)",
    shadowOpacity: 0,
    elevation: 0
  },
  buttonOutlineDangerPressed: {
    backgroundColor: "rgba(154, 82, 63, 0.1)"
  },
  buttonOutlinePressed: {
    backgroundColor: appColors.accentSoft
  },
  buttonSecondary: {
    backgroundColor: appColors.accentSoft,
    borderColor: "transparent",
    shadowOpacity: 0,
    elevation: 0
  },
  buttonText: {
    color: appColors.canvas,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.2
  },
  buttonTextGhost: {
    color: appColors.accent
  },
  buttonTextOutline: {
    color: appColors.accent
  },
  buttonTextOutlineDanger: {
    color: appColors.dangerText
  },
  buttonTextDanger: {
    color: appColors.dangerText
  },
  buttonTextDisabledMuted: {
    color: appColors.muted
  },
  buttonTextSecondary: {
    color: appColors.accent
  },
  chip: {
    alignSelf: "flex-start",
    backgroundColor: appColors.accentSoft,
    borderColor: "transparent",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  chipAccent: {
    backgroundColor: appColors.accentSoft,
    borderColor: "transparent"
  },
  chipText: {
    color: appColors.accent,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.1
  },
  chipTextAccent: {
    color: appColors.accent
  },
  display: {
    color: appColors.text,
    fontSize: 40,
    letterSpacing: 0,
    lineHeight: 43
  },
  headline: {
    color: appColors.text,
    fontSize: 31,
    letterSpacing: 0,
    lineHeight: 36
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 52,
    paddingHorizontal: 16
  },
  input: {
    flex: 1,
    color: appColors.text,
    fontSize: 16,
    paddingVertical: 12
  },
  inputFocused: {
    borderColor: appColors.accent,
    elevation: 0
  },
  inputRightElement: {
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8
  },
  label: {
    color: appColors.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase"
  },
  accentText: {
    color: appColors.accent
  },
  mutedText: {
    color: appColors.muted
  },
  surface: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 14,
    padding: 20,
    shadowColor: appColors.shadow,
    shadowOffset: {
      width: 0,
      height: 6
    },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: Platform.OS === "android" ? 2 : 0
  },
  surfaceSubtle: {
    backgroundColor: "#f1eadf",
    shadowOpacity: 0,
    elevation: 0
  },
  text: {
    color: appColors.text,
    fontSize: 16,
    lineHeight: 24
  },
  title: {
    color: appColors.text,
    fontSize: 22,
    letterSpacing: 0,
    lineHeight: 28
  }
});
