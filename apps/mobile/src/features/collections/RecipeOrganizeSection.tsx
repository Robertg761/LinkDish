import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppText } from "@linkdish/ui";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import {
  formatCollectionLabel,
  getRecipeCollectionIds,
  getRecipeTags
} from "../saved-recipes/collections";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { Chip } from "./Chip";
import { CollectionPickerSheet } from "./CollectionPickerSheet";
import { TagEditorSheet } from "./TagEditorSheet";

import type { SavedRecipeRecord } from "../saved-recipes/store";

/** A saved recipe's tags and collections on its page, each with a way to change them. */
export const RecipeOrganizeSection = ({ record }: { record: SavedRecipeRecord }) => {
  const { collections } = useSavedRecipes();
  const [openSheet, setOpenSheet] = useState<"collections" | "tags" | null>(null);
  const tags = getRecipeTags(record);
  const memberCollections = useMemo(() => {
    const ids = new Set(getRecipeCollectionIds(record));
    return collections.filter((collection) => ids.has(collection.id));
  }, [collections, record]);

  return (
    <View style={styles.section} testID="recipe-organize-section">
      <OrganizeRow
        emptyLabel="Add tags"
        icon="tag-outline"
        label="Tags"
        onEdit={() => setOpenSheet("tags")}
        values={tags}
      />
      <OrganizeRow
        emptyLabel="Add to a collection"
        icon="folder-outline"
        label="Collections"
        onEdit={() => setOpenSheet("collections")}
        values={memberCollections.map(formatCollectionLabel)}
      />
      <TagEditorSheet
        onClose={() => setOpenSheet(null)}
        recipeId={record.id}
        visible={openSheet === "tags"}
      />
      <CollectionPickerSheet
        onClose={() => setOpenSheet(null)}
        recipeId={record.id}
        visible={openSheet === "collections"}
      />
    </View>
  );
};

const OrganizeRow = ({
  emptyLabel,
  icon,
  label,
  onEdit,
  values
}: {
  emptyLabel: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  label: string;
  onEdit: () => void;
  values: readonly string[];
}) => (
  <Pressable
    accessibilityHint={`Changes this recipe's ${label.toLowerCase()}`}
    accessibilityLabel={values.length ? `${label}: ${values.join(", ")}` : emptyLabel}
    accessibilityRole="button"
    onPress={onEdit}
    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
  >
    <MaterialCommunityIcons color={appColors.accent} name={icon} size={18} />
    {values.length > 0 ? (
      <View style={styles.values}>
        {values.map((value) => (
          <Chip key={value} label={value} />
        ))}
      </View>
    ) : (
      <AppText style={styles.empty}>{emptyLabel}</AppText>
    )}
    <MaterialCommunityIcons color={appColors.muted} name="pencil-outline" size={17} />
  </Pressable>
);

const styles = StyleSheet.create({
  empty: {
    color: appColors.accent,
    flex: 1,
    fontSize: 14,
    fontWeight: "700"
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  row: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    minHeight: 48,
    paddingHorizontal: appSpacing.md,
    paddingVertical: appSpacing.sm
  },
  section: {
    gap: appSpacing.sm
  },
  values: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6
  }
});
