import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppText } from "@linkdish/ui";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { success as successHaptic } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { Chip } from "../collections/Chip";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { useMealPlan } from "./MealPlanContext";
import { SheetLabel, SlotChips } from "./PlanControls";
import {
  defaultServingsFor,
  getDayLabel,
  NOTE_PRESETS,
  rankRecipesForPlanning,
  suggestSlot,
  type MealPlanEntry,
  type MealPlanSlot
} from "./store";

import type { SavedRecipeRecord } from "../saved-recipes/store";

const MAX_LISTED_RECIPES = 40;

/**
 * "Add a meal" on one day of the plan: pick the meal, then a recipe from the cookbook (what suits
 * the meal first) or a quick note like Leftovers. Typing searches the cookbook, and anything
 * typed can also be planned as a note.
 */
export const PlanMealSheet = ({
  date,
  dayEntries,
  onClose,
  visible
}: {
  date: string;
  dayEntries: readonly MealPlanEntry[];
  onClose: () => void;
  visible: boolean;
}) => {
  const { savedRecipes } = useSavedRecipes();
  const { addEntry } = useMealPlan();
  const [slot, setSlot] = useState<MealPlanSlot>(() => suggestSlot(dayEntries));
  const [query, setQuery] = useState("");
  const wasVisibleRef = useRef(visible);

  // Each time the sheet opens: the likeliest free meal, and a fresh search.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    if (visible && !wasVisible) {
      setSlot(suggestSlot(dayEntries));
      setQuery("");
    }
  }, [dayEntries, visible]);

  const recipes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const ranked = rankRecipesForPlanning(savedRecipes, slot);
    return (
      needle
        ? ranked.filter((record) => record.recipe.title.toLocaleLowerCase().includes(needle))
        : ranked
    ).slice(0, MAX_LISTED_RECIPES);
  }, [query, savedRecipes, slot]);

  const plan = (input: { recipe?: SavedRecipeRecord; title: string }) => {
    const servings = defaultServingsFor(input.recipe);
    addEntry(
      {
        date,
        slot,
        title: input.title,
        ...(input.recipe ? { recipeId: input.recipe.id } : {}),
        ...(servings ? { servings } : {})
      },
      "plan"
    );
    successHaptic();
    onClose();
  };

  const typedNote = query.trim();
  const label = getDayLabel(date);

  return (
    <AppSheet
      description={`${label.weekdayLong}, ${label.monthDay}`}
      onClose={onClose}
      testID="plan-meal-sheet"
      title="Add a meal"
      visible={visible}
    >
      <SlotChips onChange={setSlot} value={slot} />

      <TextInput
        accessibilityLabel="Search your cookbook or type a note"
        autoCapitalize="sentences"
        onChangeText={setQuery}
        placeholder="Search recipes, or type a note"
        placeholderTextColor={appColors.placeholder}
        returnKeyType="done"
        style={styles.input}
        value={query}
      />

      {typedNote ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => plan({ title: typedNote })}
          style={({ pressed }) => [styles.noteRow, pressed && styles.pressed]}
          testID="plan-typed-note"
        >
          <MaterialCommunityIcons color={appColors.accent} name="note-plus-outline" size={20} />
          <AppText numberOfLines={2} style={styles.noteLabel}>
            Plan “{typedNote}” as a note
          </AppText>
        </Pressable>
      ) : (
        <View style={styles.chips}>
          {NOTE_PRESETS.map((preset) => (
            <Chip
              icon={preset.icon}
              key={preset.title}
              label={preset.title}
              onPress={() => plan({ title: preset.title })}
            />
          ))}
        </View>
      )}

      <SheetLabel>{query.trim() ? "Matching recipes" : "From your cookbook"}</SheetLabel>
      {savedRecipes.length === 0 ? (
        <AppText muted style={styles.empty}>
          Save a few recipes and they&apos;ll show up here to plan.
        </AppText>
      ) : recipes.length === 0 ? (
        <AppText muted style={styles.empty}>
          No recipes match. You can still plan it as a note.
        </AppText>
      ) : (
        <View style={styles.list}>
          {recipes.map((record) => (
            <Pressable
              accessibilityHint="Adds it to this day"
              accessibilityLabel={record.recipe.title}
              accessibilityRole="button"
              key={record.id}
              onPress={() => plan({ recipe: record, title: record.recipe.title })}
              style={({ pressed }) => [styles.recipeRow, pressed && styles.pressed]}
            >
              <View style={styles.recipeCopy}>
                <AppText numberOfLines={2} style={styles.recipeTitle}>
                  {record.recipe.title}
                </AppText>
                {describeRecipe(record) ? (
                  <AppText muted numberOfLines={1} style={styles.recipeMeta}>
                    {describeRecipe(record)}
                  </AppText>
                ) : null}
              </View>
              {record.favorite ? (
                <MaterialCommunityIcons color={appColors.tomato} name="heart" size={16} />
              ) : null}
              <MaterialCommunityIcons color={appColors.accent} name="plus" size={20} />
            </Pressable>
          ))}
        </View>
      )}
    </AppSheet>
  );
};

/** "Cooked 3× · 1 hr 20 min" */
const describeRecipe = (record: SavedRecipeRecord): string => {
  const parts: string[] = [];
  const cooked = record.timesCooked ?? 0;

  if (cooked > 0) {
    parts.push(`Cooked ${cooked}×`);
  }

  const total =
    record.recipe.totalTimeMinutes ??
    ((record.recipe.prepTimeMinutes ?? 0) + (record.recipe.cookTimeMinutes ?? 0) || null);

  if (total) {
    parts.push(
      total >= 60
        ? `${Math.floor(total / 60)} hr${total % 60 ? ` ${total % 60} min` : ""}`
        : `${total} min`
    );
  }

  return parts.join(" · ");
};

const styles = StyleSheet.create({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: appSpacing.sm
  },
  empty: {
    fontSize: 14,
    lineHeight: 20
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
  list: {
    gap: appSpacing.xs
  },
  noteLabel: {
    color: appColors.accent,
    flex: 1,
    fontSize: 15,
    fontWeight: "700"
  },
  noteRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm,
    minHeight: 44
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  recipeCopy: {
    flex: 1,
    gap: 2
  },
  recipeMeta: {
    fontSize: 12
  },
  recipeRow: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: appSpacing.sm,
    minHeight: 54,
    paddingHorizontal: appSpacing.md,
    paddingVertical: appSpacing.sm
  },
  recipeTitle: {
    fontSize: 15,
    fontWeight: "600"
  }
});
