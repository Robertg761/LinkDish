import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { appColors, appSpacing } from "../../theme/tokens";

import { useShoppingList } from "./ShoppingListContext";
import { recipeIngredientsToShoppingInputs, type ShoppingUnitMode } from "./store";

import type { Recipe } from "@linkdish/recipe-domain";

interface AddRecipeIngredientsSheetProps {
  recipe: Recipe;
  recipeId: string;
  scaleFactor: number;
  unitMode: ShoppingUnitMode;
  visible: boolean;
  onClose: () => void;
}

const normalizeSection = (section: string | null | undefined): string =>
  section?.trim() || "Ingredients";

export const AddRecipeIngredientsSheet = ({
  onClose,
  recipe,
  recipeId,
  scaleFactor,
  unitMode,
  visible
}: AddRecipeIngredientsSheetProps) => {
  const { addItems } = useShoppingList();
  const inputs = useMemo(
    () => recipeIngredientsToShoppingInputs(recipe, recipeId, { scaleFactor, unitMode }),
    [recipe, recipeId, scaleFactor, unitMode]
  );
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(
    () => new Set(inputs.map((_, index) => index))
  );
  const selectedCount = selectedIndexes.size;

  useEffect(() => {
    if (visible) {
      setSelectedIndexes(new Set(inputs.map((_, index) => index)));
    }
  }, [inputs, visible]);

  const groupedInputs = useMemo(() => {
    const groups: Array<{ key: string; label: string; indexes: number[] }> = [];

    inputs.forEach((input, index) => {
      const label = normalizeSection(input.section);
      const currentGroup = groups[groups.length - 1];

      if (!currentGroup || currentGroup.label !== label) {
        groups.push({
          key: `${label}-${index}`,
          label,
          indexes: []
        });
      }

      groups[groups.length - 1]?.indexes.push(index);
    });

    return groups;
  }, [inputs]);

  const toggleIndex = (index: number) => {
    setSelectedIndexes((current) => {
      const next = new Set(current);

      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }

      return next;
    });
  };

  const confirmSelection = () => {
    addItems(inputs.filter((_, index) => selectedIndexes.has(index)));
    onClose();
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <AppText style={styles.title} variant="headline">
              Add ingredients
            </AppText>
            <AppText muted numberOfLines={2}>
              {recipe.title}
            </AppText>
          </View>
          <Pressable
            accessibilityLabel="Close add ingredients"
            accessibilityRole="button"
            hitSlop={10}
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons color={appColors.muted} name="close" size={22} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {groupedInputs.map((group) => (
            <AppSurface key={group.key} style={styles.section}>
              <AppText tone="accent" variant="label">
                {group.label}
              </AppText>
              <View style={styles.itemStack}>
                {group.indexes.map((index) => {
                  const input = inputs[index];
                  const checked = selectedIndexes.has(index);

                  if (!input) {
                    return null;
                  }

                  return (
                    <Pressable
                      accessibilityLabel={`${checked ? "Remove" : "Add"} ${input.text}`}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      key={`${index}-${input.text}`}
                      onPress={() => toggleIndex(index)}
                      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                    >
                      <View style={[styles.check, checked && styles.checkSelected]}>
                        {checked ? (
                          <MaterialCommunityIcons color={appColors.canvas} name="check" size={13} />
                        ) : null}
                      </View>
                      <AppText style={styles.rowText}>{input.text}</AppText>
                    </Pressable>
                  );
                })}
              </View>
            </AppSurface>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          <AppButton label="Cancel" onPress={onClose} style={styles.footerButton} variant="outline" />
          <AppButton
            disabled={selectedCount === 0}
            label={selectedCount === 1 ? "Add 1 item" : `Add ${selectedCount} items`}
            onPress={confirmSelection}
            style={styles.footerButton}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  check: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    width: 22
  },
  checkSelected: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  closeButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  content: {
    gap: appSpacing.md,
    padding: appSpacing.lg,
    paddingBottom: appSpacing.xxl
  },
  footer: {
    backgroundColor: appColors.background,
    borderTopColor: appColors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    padding: appSpacing.lg
  },
  footerButton: {
    flex: 1,
    paddingHorizontal: 12
  },
  header: {
    alignItems: "center",
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: appSpacing.md,
    padding: appSpacing.lg
  },
  headerCopy: {
    flex: 1,
    gap: 4
  },
  itemStack: {
    gap: 8
  },
  pressed: {
    opacity: 0.72
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md,
    minHeight: 36
  },
  rowText: {
    flex: 1
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  section: {
    gap: appSpacing.md
  },
  title: {
    fontSize: 28,
    lineHeight: 32
  }
});
