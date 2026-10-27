import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText } from "@linkdish/ui";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { selectionTick } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import {
  countRecipesByCollection,
  formatCollectionLabel,
  formatRecipeCount,
  getRecipeCollectionIds
} from "../saved-recipes/collections";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { CollectionForm } from "./CollectionForm";

/** Which collections one recipe is in: tap to add or take it out, or make a new one for it. */
export const CollectionPickerSheet = ({
  onClose,
  recipeId,
  visible
}: {
  onClose: () => void;
  recipeId: string;
  visible: boolean;
}) => {
  const { collections, createCollection, savedRecipes, setRecipeCollections } = useSavedRecipes();
  const [isCreating, setIsCreating] = useState(false);
  const record = useMemo(
    () => savedRecipes.find((entry) => entry.id === recipeId),
    [recipeId, savedRecipes]
  );
  const memberIds = useMemo(() => (record ? getRecipeCollectionIds(record) : []), [record]);
  const counts = useMemo(() => countRecipesByCollection(savedRecipes), [savedRecipes]);

  const toggle = (collectionId: string) => {
    selectionTick();
    setRecipeCollections(
      recipeId,
      memberIds.includes(collectionId)
        ? memberIds.filter((id) => id !== collectionId)
        : [...memberIds, collectionId]
    );
  };

  const close = () => {
    setIsCreating(false);
    onClose();
  };

  return (
    <AppSheet
      description={record?.recipe.title}
      footer={isCreating ? undefined : <AppButton label="Done" onPress={close} />}
      onClose={close}
      testID="collection-picker-sheet"
      title="Collections"
      visible={visible}
    >
      {collections.length === 0 && !isCreating ? (
        <AppText muted style={styles.empty}>
          Collections group recipes your way: weeknights, holiday baking, the good soups.
        </AppText>
      ) : null}

      <View style={styles.list}>
        {collections.map((collection) => {
          const checked = memberIds.includes(collection.id);

          return (
            <Pressable
              accessibilityLabel={formatCollectionLabel(collection)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              key={collection.id}
              onPress={() => toggle(collection.id)}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <MaterialCommunityIcons
                color={checked ? appColors.accent : appColors.muted}
                name={checked ? "checkbox-marked" : "checkbox-blank-outline"}
                size={22}
              />
              <View style={styles.rowCopy}>
                <AppText numberOfLines={1} style={styles.rowTitle}>
                  {formatCollectionLabel(collection)}
                </AppText>
                <AppText muted style={styles.rowMeta}>
                  {formatRecipeCount(counts.get(collection.id) ?? 0)}
                </AppText>
              </View>
            </Pressable>
          );
        })}
      </View>

      {isCreating ? (
        <CollectionForm
          onCancel={() => setIsCreating(false)}
          onSubmit={(input) => {
            const created = createCollection(input);
            setRecipeCollections(recipeId, [...memberIds, created.id]);
            setIsCreating(false);
          }}
          submitLabel="Create and add"
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setIsCreating(true)}
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}
          testID="new-collection-button"
        >
          <MaterialCommunityIcons color={appColors.accent} name="plus" size={20} />
          <AppText style={styles.newLabel}>New collection</AppText>
        </Pressable>
      )}
    </AppSheet>
  );
};

const styles = StyleSheet.create({
  empty: {
    fontSize: 14,
    lineHeight: 20
  },
  list: {
    gap: appSpacing.xs
  },
  newLabel: {
    color: appColors.accent,
    fontSize: 15,
    fontWeight: "700"
  },
  newRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm,
    minHeight: 44
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
    gap: appSpacing.md,
    minHeight: 54,
    paddingHorizontal: appSpacing.md
  },
  rowCopy: {
    flex: 1
  },
  rowMeta: {
    fontSize: 12
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600"
  }
});
