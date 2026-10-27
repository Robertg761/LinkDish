import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  canonicalIngredientKey,
  formatShoppingItemText,
  isPantryStaple,
  SHOPPING_CATEGORIES
} from "@linkdish/recipe-domain";
import { AppButton, AppText } from "@linkdish/ui";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { AppSheet } from "../../components/AppSheet";
import { selectionTick, success as successHaptic } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { useShoppingList } from "../shopping/ShoppingListContext";

import { SheetLabel } from "./PlanControls";
import {
  buildPlanShopping,
  toShoppingListInput,
  type MealPlanEntry,
  type PlanShopping
} from "./store";

import type { SavedRecipeRecord } from "../saved-recipes/store";
import type { AggregatedShoppingItem } from "@linkdish/recipe-domain";

const itemCount = (count: number) => (count === 1 ? "1 item" : `${count} items`);

/**
 * "Shop for the week", as on the web: every planned recipe's ingredients for the week, scaled to
 * each meal's servings, merged ("2 onions" + "1 onion" = "3 onions") and sorted by aisle. Pantry
 * staples start unticked, and items already on the list say so.
 */
export const PlanShoppingSheet = ({
  entries,
  onClose,
  recipesById,
  visible,
  weekLabel
}: {
  entries: readonly MealPlanEntry[];
  onClose: () => void;
  recipesById: ReadonlyMap<string, SavedRecipeRecord>;
  visible: boolean;
  /** "Sep 28 – Oct 4" */
  weekLabel: string;
}) => {
  const { addItems, shoppingItems } = useShoppingList();
  const current = useMemo(() => buildPlanShopping(entries, recipesById), [entries, recipesById]);
  // The list is fixed while the sheet is open, so a sync landing meanwhile can't shift what the
  // ticks (by position) point at.
  const [opened, setOpened] = useState<PlanShopping | null>(null);
  const planned = opened ?? current;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [added, setAdded] = useState<number | null>(null);
  const wasVisibleRef = useRef(false);

  // Each time the sheet opens, everything but pantry staples is ticked.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    if (visible && !wasVisible) {
      setOpened(current);
      setSelected(
        new Set(current.items.flatMap((item, index) => (isPantryStaple(item.text) ? [] : [index])))
      );
      setAdded(null);
    } else if (!visible && wasVisible) {
      setOpened(null);
    }
  }, [current, visible]);

  const openKeys = useMemo(
    () =>
      new Set(
        shoppingItems
          .filter((item) => !item.checked)
          .map((item) => canonicalIngredientKey(item.text))
      ),
    [shoppingItems]
  );

  const groups = useMemo(() => {
    const byCategory = new Map<string, Array<{ index: number; item: AggregatedShoppingItem }>>();

    planned.items.forEach((item, index) => {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push({ index, item });
      byCategory.set(item.category, bucket);
    });

    return SHOPPING_CATEGORIES.flatMap(({ id, label }) => {
      const rows = byCategory.get(id);
      return rows ? [{ id, label, rows }] : [];
    });
  }, [planned.items]);

  const toggle = (index: number) => {
    selectionTick();
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }

      return next;
    });
  };

  const confirm = () => {
    const chosen = planned.items.filter((_item, index) => selected.has(index));

    if (chosen.length === 0) {
      return;
    }

    addItems(chosen.map(toShoppingListInput));
    trackMobileEvent({
      eventName: "meal_plan_shopping_generated",
      properties: {
        added_count: chosen.length,
        item_count: planned.items.length,
        meal_count: planned.mealCount,
        recipe_count: planned.recipeCount
      },
      routeOrScreen: "plan"
    });
    successHaptic();
    setAdded(chosen.length);
  };

  const count = selected.size;
  const recipeCount = `${planned.recipeCount} ${planned.recipeCount === 1 ? "recipe" : "recipes"}`;

  return (
    <AppSheet
      description={`${weekLabel} · ${recipeCount}, merged and sorted by aisle`}
      footer={
        added != null ? (
          <View style={styles.footerRow}>
            <AppButton
              label="Done"
              onPress={onClose}
              style={styles.footerButton}
              variant="outline"
            />
            <AppButton
              label="View list"
              onPress={() => {
                onClose();
                router.push("/shopping");
              }}
              style={styles.footerButton}
            />
          </View>
        ) : planned.items.length > 0 ? (
          <AppButton
            disabled={count === 0}
            label={count === 0 ? "Pick some items" : `Add ${itemCount(count)}`}
            onPress={confirm}
          />
        ) : null
      }
      onClose={onClose}
      testID="plan-shopping-sheet"
      title="Shop for the week"
      visible={visible}
    >
      {added != null ? (
        <AppText style={styles.done}>{`Added ${itemCount(added)} to your shopping list.`}</AppText>
      ) : (
        <>
          {planned.skippedCount > 0 ? (
            <View style={styles.note}>
              <MaterialCommunityIcons
                color={appColors.muted}
                name="information-outline"
                size={16}
              />
              <AppText muted style={styles.noteText}>
                {planned.skippedCount === 1
                  ? "1 meal has no recipe (like leftovers), so it adds nothing."
                  : `${planned.skippedCount} meals have no recipe (like leftovers), so they add nothing.`}
              </AppText>
            </View>
          ) : null}
          {planned.items.length === 0 ? (
            <AppText muted style={styles.noteText}>
              Plan a few recipes this week and their ingredients will show up here.
            </AppText>
          ) : null}
          {groups.map((group) => (
            <View key={group.id} style={styles.group}>
              <SheetLabel>{group.label}</SheetLabel>
              {group.rows.map(({ index, item }) => {
                const checked = selected.has(index);
                const label = formatShoppingItemText(item);
                const detail = [
                  item.recipeTitles.length > 1
                    ? `${item.recipeTitles[0] ?? ""} +${item.recipeTitles.length - 1}`
                    : item.recipeTitles[0],
                  openKeys.has(item.key) ? "On your list" : undefined,
                  isPantryStaple(item.text) ? "Pantry staple" : undefined
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <Pressable
                    accessibilityLabel={label}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    key={index}
                    onPress={() => toggle(index)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <MaterialCommunityIcons
                      color={checked ? appColors.accent : appColors.muted}
                      name={checked ? "checkbox-marked" : "checkbox-blank-outline"}
                      size={22}
                    />
                    <View style={styles.rowCopy}>
                      <AppText style={styles.rowTitle}>{label}</AppText>
                      {detail ? (
                        <AppText muted numberOfLines={1} style={styles.rowMeta}>
                          {detail}
                        </AppText>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </>
      )}
    </AppSheet>
  );
};

const styles = StyleSheet.create({
  done: {
    color: appColors.text,
    fontSize: 16,
    lineHeight: 22
  },
  footerButton: {
    flex: 1
  },
  footerRow: {
    flexDirection: "row",
    gap: appSpacing.sm
  },
  group: {
    gap: appSpacing.xs
  },
  note: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  noteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md,
    minHeight: 46
  },
  rowCopy: {
    flex: 1,
    gap: 1
  },
  rowMeta: {
    fontSize: 12
  },
  rowTitle: {
    fontSize: 15
  }
});
