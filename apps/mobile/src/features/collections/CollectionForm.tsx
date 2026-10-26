import { AppButton, AppText } from "@linkdish/ui";
import React, { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import {
  COLLECTION_EMOJI_CHOICES,
  CollectionValidationError,
  type CollectionInput
} from "../saved-recipes/collections";

/**
 * A collection's name and emoji. `onSubmit` may throw a CollectionValidationError, whose message
 * shows under the field.
 */
export const CollectionForm = ({
  initial,
  onCancel,
  onSubmit,
  submitLabel
}: {
  initial?: CollectionInput | undefined;
  onCancel?: (() => void) | undefined;
  onSubmit: (input: CollectionInput) => void;
  submitLabel: string;
}) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      onSubmit({ emoji, name });
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof CollectionValidationError
          ? caught.message
          : "That collection couldn't be saved. Please try again."
      );
    }
  };

  return (
    <View style={styles.form}>
      <TextInput
        accessibilityLabel="Collection name"
        autoFocus
        maxLength={80}
        onChangeText={(value) => {
          setName(value);
          setError(null);
        }}
        onSubmitEditing={submit}
        placeholder="Name, like Weeknights"
        placeholderTextColor={appColors.placeholder}
        returnKeyType="done"
        style={[styles.input, error ? styles.inputError : null]}
        value={name}
      />
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <View accessibilityLabel="Emoji" style={styles.emojiRow}>
        {COLLECTION_EMOJI_CHOICES.map((choice) => {
          const selected = choice === emoji;

          return (
            <Pressable
              accessibilityLabel={selected ? `Remove emoji ${choice}` : `Use emoji ${choice}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={choice}
              onPress={() => setEmoji(selected ? "" : choice)}
              style={({ pressed }) => [
                styles.emoji,
                selected && styles.emojiSelected,
                pressed && styles.pressed
              ]}
            >
              <AppText style={styles.emojiText}>{choice}</AppText>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.actions}>
        {onCancel ? (
          <AppButton label="Cancel" onPress={onCancel} style={styles.action} variant="outline" />
        ) : null}
        <AppButton label={submitLabel} onPress={submit} style={styles.action} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  action: {
    flex: 1,
    minHeight: 46
  },
  actions: {
    flexDirection: "row",
    gap: appSpacing.sm
  },
  emoji: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 10,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  emojiRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6
  },
  emojiSelected: {
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.accent
  },
  emojiText: {
    fontSize: 20
  },
  error: {
    color: appColors.danger,
    fontSize: 13
  },
  form: {
    gap: appSpacing.md
  },
  input: {
    backgroundColor: appColors.background,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: appColors.text,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: appSpacing.md
  },
  inputError: {
    borderColor: appColors.danger
  },
  pressed: {
    opacity: pressedOpacity.medium
  }
});
