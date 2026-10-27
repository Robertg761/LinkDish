import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppText } from "@linkdish/ui";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { warn as warnHaptic } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import {
  countRecipesByCollection,
  formatCollectionLabel,
  formatRecipeCount
} from "../saved-recipes/collections";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { CollectionForm } from "./CollectionForm";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | { kind: "delete"; id: string };

/** Create, rename, re-emoji, reorder and delete collections. */
export const ManageCollectionsSheet = ({
  onClose,
  onDeleted,
  visible
}: {
  onClose: () => void;
  /** A collection was deleted (the Cookbook drops its filter). */
  onDeleted?: (id: string) => void;
  visible: boolean;
}) => {
  const { collections, createCollection, deleteCollection, savedRecipes, updateCollection } =
    useSavedRecipes();
  const [editing, setEditing] = useState<Editing | null>(null);
  const counts = useMemo(() => countRecipesByCollection(savedRecipes), [savedRecipes]);

  const close = () => {
    setEditing(null);
    onClose();
  };

  /** Swaps a collection with its neighbour, renumbering the order so every place is distinct. */
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;

    if (target < 0 || target >= collections.length) {
      return;
    }

    const reordered = [...collections];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    reordered.forEach((collection, position) => {
      if (collection.sortOrder !== position) {
        updateCollection(collection.id, { sortOrder: position });
      }
    });
  };

  return (
    <AppSheet
      footer={editing ? undefined : <AppButton label="Done" onPress={close} />}
      onClose={close}
      testID="manage-collections-sheet"
      title="Collections"
      visible={visible}
    >
      {collections.length === 0 && editing?.kind !== "new" ? (
        <AppText muted style={styles.empty}>
          No collections yet. Make one, then add recipes to it from a recipe&apos;s page.
        </AppText>
      ) : null}

      <View style={styles.list}>
        {collections.map((collection, index) => {
          if (editing?.kind === "edit" && editing.id === collection.id) {
            return (
              <CollectionForm
                initial={collection}
                key={collection.id}
                onCancel={() => setEditing(null)}
                onSubmit={(input) => {
                  updateCollection(collection.id, input);
                  setEditing(null);
                }}
                submitLabel="Save"
              />
            );
          }

          if (editing?.kind === "delete" && editing.id === collection.id) {
            const count = counts.get(collection.id) ?? 0;

            return (
              <View key={collection.id} style={styles.confirm}>
                <AppText style={styles.rowTitle}>
                  Delete “{formatCollectionLabel(collection)}”?
                </AppText>
                <AppText muted style={styles.rowMeta}>
                  {count > 0
                    ? `${formatRecipeCount(count)} stay in your cookbook; only the collection goes.`
                    : "It has no recipes in it."}
                </AppText>
                <View style={styles.confirmActions}>
                  <AppButton
                    label="Keep"
                    onPress={() => setEditing(null)}
                    style={styles.confirmAction}
                    variant="outline"
                  />
                  <AppButton
                    label="Delete"
                    onPress={() => {
                      warnHaptic();
                      deleteCollection(collection.id);
                      onDeleted?.(collection.id);
                      setEditing(null);
                    }}
                    style={styles.confirmAction}
                    variant="danger"
                  />
                </View>
              </View>
            );
          }

          return (
            <View key={collection.id} style={styles.row}>
              <View style={styles.rowCopy}>
                <AppText numberOfLines={1} style={styles.rowTitle}>
                  {formatCollectionLabel(collection)}
                </AppText>
                <AppText muted style={styles.rowMeta}>
                  {formatRecipeCount(counts.get(collection.id) ?? 0)}
                </AppText>
              </View>
              <RowAction
                disabled={index === 0}
                icon="arrow-up"
                label={`Move ${collection.name} up`}
                onPress={() => move(index, -1)}
              />
              <RowAction
                disabled={index === collections.length - 1}
                icon="arrow-down"
                label={`Move ${collection.name} down`}
                onPress={() => move(index, 1)}
              />
              <RowAction
                icon="pencil-outline"
                label={`Edit ${collection.name}`}
                onPress={() => setEditing({ id: collection.id, kind: "edit" })}
              />
              <RowAction
                icon="trash-can-outline"
                label={`Delete ${collection.name}`}
                onPress={() => setEditing({ id: collection.id, kind: "delete" })}
              />
            </View>
          );
        })}
      </View>

      {editing?.kind === "new" ? (
        <CollectionForm
          onCancel={() => setEditing(null)}
          onSubmit={(input) => {
            createCollection(input);
            setEditing(null);
          }}
          submitLabel="Create"
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setEditing({ kind: "new" })}
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}
          testID="manage-new-collection-button"
        >
          <MaterialCommunityIcons color={appColors.accent} name="plus" size={20} />
          <AppText style={styles.newLabel}>New collection</AppText>
        </Pressable>
      )}
    </AppSheet>
  );
};

const RowAction = ({
  disabled = false,
  icon,
  label,
  onPress
}: {
  disabled?: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  label: string;
  onPress: () => void;
}) => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    disabled={disabled}
    hitSlop={6}
    onPress={onPress}
    style={({ pressed }) => [
      styles.rowAction,
      disabled && styles.rowActionDisabled,
      pressed && styles.pressed
    ]}
  >
    <MaterialCommunityIcons color={appColors.muted} name={icon} size={19} />
  </Pressable>
);

const styles = StyleSheet.create({
  confirm: {
    backgroundColor: appColors.dangerSoft,
    borderRadius: 12,
    gap: appSpacing.sm,
    padding: appSpacing.md
  },
  confirmAction: {
    flex: 1,
    minHeight: 44
  },
  confirmActions: {
    flexDirection: "row",
    gap: appSpacing.sm
  },
  empty: {
    fontSize: 14,
    lineHeight: 20
  },
  list: {
    gap: appSpacing.sm
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
    gap: 2,
    minHeight: 56,
    paddingLeft: appSpacing.md,
    paddingRight: appSpacing.xs
  },
  rowAction: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    width: 34
  },
  rowActionDisabled: {
    opacity: 0.3
  },
  rowCopy: {
    flex: 1,
    paddingRight: appSpacing.xs
  },
  rowMeta: {
    fontSize: 12
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600"
  }
});
