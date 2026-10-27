import { inferRecipeTags } from "@linkdish/recipe-domain";
import { AppButton, AppText } from "@linkdish/ui";
import React, { useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { appColors, appSpacing } from "../../theme/tokens";
import {
  collectCookbookTags,
  getRecipeTags,
  normalizeRecipeTags
} from "../saved-recipes/collections";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { Chip } from "./Chip";

const MAX_SUGGESTIONS = 10;
const MAX_OWN_TAGS = 8;
const TAG_SEPARATOR_PATTERN = /[,\n]/u;

/**
 * Tags for one recipe as removable chips, with a field (Done or a comma adds) and suggestions
 * from the recipe itself (course, cuisine, method, diet, quick) and the cook's other tags, as on
 * the web. Every change saves immediately.
 */
export const TagEditorSheet = ({
  onClose,
  recipeId,
  visible
}: {
  onClose: () => void;
  recipeId: string;
  visible: boolean;
}) => {
  const { savedRecipes, setRecipeTags } = useSavedRecipes();
  const [draft, setDraft] = useState("");
  const record = useMemo(
    () => savedRecipes.find((entry) => entry.id === recipeId),
    [recipeId, savedRecipes]
  );
  const tags = useMemo(() => (record ? getRecipeTags(record) : []), [record]);

  // Tags read from this recipe, then the cook's other tags (ones the recipe mentions first).
  const { ownTags, suggestions } = useMemo(() => {
    if (!record) {
      return { ownTags: [], suggestions: [] };
    }

    const existing = collectCookbookTags(savedRecipes).map((entry) => entry.label);
    const existingByKey = new Map(existing.map((tag) => [tag.toLowerCase(), tag]));
    const seen = new Set(tags.map((tag) => tag.toLowerCase()));
    const fresh = (tag: string) => {
      const key = tag.toLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    };
    // The cook's own spelling of a tag wins; otherwise the suggestion is capitalized.
    const inferred = inferRecipeTags(record.recipe)
      .tags.map(
        (tag) =>
          existingByKey.get(tag.toLowerCase()) ?? `${tag.charAt(0).toUpperCase()}${tag.slice(1)}`
      )
      .filter(fresh)
      .slice(0, MAX_SUGGESTIONS);
    const text = [record.recipe.title, ...record.recipe.ingredients.map((entry) => entry.text)]
      .join(" ")
      .toLowerCase();
    const mentioned = (tag: string) => (text.includes(tag.toLowerCase()) ? 0 : 1);
    const own = existing
      .map((tag, rank) => ({ rank, tag }))
      .sort((left, right) => mentioned(left.tag) - mentioned(right.tag) || left.rank - right.rank)
      .map((entry) => entry.tag)
      .filter(fresh)
      .slice(0, MAX_OWN_TAGS);

    return { ownTags: own, suggestions: inferred };
  }, [record, savedRecipes, tags]);

  const addTags = (raw: string) => {
    const incoming = normalizeRecipeTags(raw.split(TAG_SEPARATOR_PATTERN));

    if (incoming.length > 0) {
      setRecipeTags(recipeId, [...tags, ...incoming]);
    }
  };

  const commitDraft = () => {
    if (draft.trim()) {
      addTags(draft);
      setDraft("");
    }
  };

  const close = () => {
    commitDraft();
    onClose();
  };

  return (
    <AppSheet
      description={record?.recipe.title}
      footer={<AppButton label="Done" onPress={close} />}
      onClose={close}
      testID="tag-editor-sheet"
      title="Tags"
      visible={visible}
    >
      {tags.length > 0 ? (
        <View accessibilityLabel="Tags on this recipe" style={styles.chips}>
          {tags.map((tag) => (
            <Chip
              accessibilityLabel={`Remove tag ${tag}`}
              key={tag}
              label={tag}
              onPress={() =>
                setRecipeTags(
                  recipeId,
                  tags.filter((entry) => entry !== tag)
                )
              }
              selected
              trailingIcon="close"
            />
          ))}
        </View>
      ) : null}

      <TextInput
        accessibilityLabel="Add a tag"
        autoCapitalize="none"
        onBlur={commitDraft}
        onChangeText={(value) => {
          if (TAG_SEPARATOR_PATTERN.test(value)) {
            addTags(value);
            setDraft("");
          } else {
            setDraft(value);
          }
        }}
        onSubmitEditing={commitDraft}
        placeholder={tags.length ? "Add another tag" : "Add a tag, like weeknight"}
        placeholderTextColor={appColors.placeholder}
        returnKeyType="done"
        style={styles.input}
        submitBehavior="submit"
        value={draft}
      />

      {suggestions.length > 0 ? (
        <TagChoices onAdd={addTags} tags={suggestions} title="Suggested for this recipe" />
      ) : null}
      {ownTags.length > 0 ? <TagChoices onAdd={addTags} tags={ownTags} title="Your tags" /> : null}
      <AppText muted style={styles.hint}>
        Tags show up as filters in your Cookbook and help search find this recipe.
      </AppText>
    </AppSheet>
  );
};

const TagChoices = ({
  onAdd,
  tags,
  title
}: {
  onAdd: (tag: string) => void;
  tags: readonly string[];
  title: string;
}) => (
  <View style={styles.section}>
    <AppText style={styles.sectionTitle} variant="label">
      {title}
    </AppText>
    <View style={styles.chips}>
      {tags.map((tag) => (
        <Chip
          accessibilityLabel={`Add tag ${tag}`}
          icon="plus"
          key={tag}
          label={tag}
          onPress={() => onAdd(tag)}
        />
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: appSpacing.sm
  },
  hint: {
    fontSize: 13,
    lineHeight: 18
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
  section: {
    gap: appSpacing.sm
  },
  sectionTitle: {
    fontSize: 12,
    letterSpacing: 0.6
  }
});
