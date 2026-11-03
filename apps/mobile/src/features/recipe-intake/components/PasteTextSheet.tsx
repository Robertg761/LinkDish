import { AppButton, AppText } from "@linkdish/ui";
import React, { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { AppSheet } from "../../../components/AppSheet";
import { appColors, appSpacing } from "../../../theme/tokens";
import {
  getOnlyLink,
  getTextInputProblem,
  MAX_IMPORT_TEXT_CHARS,
  measureImportText,
  MIN_IMPORT_TEXT_CHARS
} from "../textImport";

interface PasteTextSheetProps {
  onClose: () => void;
  /** The text is really just a link: import it as one. */
  onImportLink: (url: string) => void;
  onImportText: (text: string) => void;
  visible: boolean;
}

const numberFormat = new Intl.NumberFormat();

/** A caption, a note or an email with a recipe in it: LinkDish sorts it into a recipe card. */
export const PasteTextSheet = ({
  onClose,
  onImportLink,
  onImportText,
  visible
}: PasteTextSheetProps) => {
  const [text, setText] = useState("");
  const [showError, setShowError] = useState(false);
  const length = measureImportText(text);
  const problem = getTextInputProblem(text);
  const onlyLink = getOnlyLink(text);

  useEffect(() => {
    if (!visible) {
      setShowError(false);
    }
  }, [visible]);

  const handleSubmit = () => {
    if (onlyLink) {
      onImportLink(onlyLink);
      setText("");
      return;
    }

    if (problem) {
      setShowError(true);
      return;
    }

    onImportText(text);
    setText("");
  };

  const errorText =
    problem === "too_long"
      ? `That's a lot of text. Trim it to ${numberFormat.format(MAX_IMPORT_TEXT_CHARS)} characters or fewer.`
      : length === 0
        ? "Paste the recipe text first."
        : `Add a little more: at least ${MIN_IMPORT_TEXT_CHARS} characters, ideally the ingredients and the steps.`;

  return (
    <AppSheet
      footer={<AppButton label="Get the recipe" onPress={handleSubmit} />}
      onClose={onClose}
      testID="paste-text-sheet"
      title="Paste recipe text"
      visible={visible}
    >
      <AppText muted style={styles.hint}>
        From a caption, a note or an email. Ingredients and steps are all we need.
      </AppText>
      <View style={[styles.box, showError && problem ? styles.boxError : null]}>
        <TextInput
          accessibilityLabel="Recipe text"
          maxLength={MAX_IMPORT_TEXT_CHARS + 2_000}
          multiline
          onChangeText={(value) => {
            setText(value);
            setShowError(false);
          }}
          placeholder={"Paste a recipe here.\n\nLabel the ingredients and steps for best results."}
          placeholderTextColor={appColors.placeholder}
          style={styles.input}
          textAlignVertical="top"
          value={text}
        />
        <AppText muted style={[styles.counter, problem === "too_long" ? styles.counterOver : null]}>
          {numberFormat.format(length)} / {numberFormat.format(MAX_IMPORT_TEXT_CHARS)}
        </AppText>
      </View>
      {showError && problem ? (
        <AppText style={styles.error}>{errorText}</AppText>
      ) : onlyLink ? (
        <AppText muted style={styles.hint}>
          That’s a link. We’ll import it as one.
        </AppText>
      ) : null}
    </AppSheet>
  );
};

const styles = StyleSheet.create({
  box: {
    backgroundColor: appColors.background,
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: appSpacing.xs,
    padding: appSpacing.md
  },
  boxError: {
    borderColor: appColors.danger
  },
  counter: {
    alignSelf: "flex-end",
    fontSize: 12
  },
  counterOver: {
    color: appColors.danger
  },
  error: {
    color: appColors.danger,
    fontSize: 14,
    lineHeight: 18
  },
  hint: {
    fontSize: 14,
    lineHeight: 19
  },
  input: {
    color: appColors.text,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 320,
    minHeight: 180
  }
});
