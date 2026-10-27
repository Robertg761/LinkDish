import { MaterialCommunityIcons } from "@expo/vector-icons";
import { addDaysToIsoDate, toIsoDate } from "@linkdish/recipe-domain";
import { AppText } from "@linkdish/ui";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { AddToPlanSheet } from "../meal-plan/AddToPlanSheet";
import { useMealPlan } from "../meal-plan/MealPlanContext";
import { relativeDayName, SLOT_LABELS } from "../meal-plan/store";
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

const MAX_LISTED_PLANS = 3;

/**
 * A saved recipe's tags, collections and upcoming meal plan days on its page, each with a way to
 * change them.
 */
export const RecipeOrganizeSection = ({ record }: { record: SavedRecipeRecord }) => {
  const { collections } = useSavedRecipes();
  const { entries, hasLoadedMealPlan, isMealPlanReadable } = useMealPlan();
  // A plan that couldn't be read isn't saved to, so there is nothing to add to.
  const canPlan = !hasLoadedMealPlan || isMealPlanReadable;
  const [openSheet, setOpenSheet] = useState<"collections" | "plan" | "tags" | null>(null);
  const tags = getRecipeTags(record);
  const memberCollections = useMemo(() => {
    const ids = new Set(getRecipeCollectionIds(record));
    return collections.filter((collection) => ids.has(collection.id));
  }, [collections, record]);
  const upcomingPlans = useMemo(() => {
    const today = toIsoDate(new Date());
    const tomorrow = addDaysToIsoDate(today, 1);
    return entries
      .filter((entry) => entry.recipeId === record.id && entry.date >= today)
      .slice(0, MAX_LISTED_PLANS)
      .map(
        (entry) =>
          `${relativeDayName(entry.date, today, tomorrow)} ${SLOT_LABELS[entry.slot].toLowerCase()}`
      );
  }, [entries, record.id]);

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
      {canPlan ? (
        <OrganizeRow
          editIcon="plus"
          emptyLabel="Add to meal plan"
          icon="calendar-week"
          label="Meal plan"
          onEdit={() => setOpenSheet("plan")}
          values={upcomingPlans}
        />
      ) : null}
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
      {openSheet === "plan" && canPlan ? (
        <AddToPlanSheet onClose={() => setOpenSheet(null)} record={record} visible />
      ) : null}
    </View>
  );
};

const OrganizeRow = ({
  editIcon = "pencil-outline",
  emptyLabel,
  icon,
  label,
  onEdit,
  values
}: {
  editIcon?: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
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
    <MaterialCommunityIcons color={appColors.muted} name={editIcon} size={17} />
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
