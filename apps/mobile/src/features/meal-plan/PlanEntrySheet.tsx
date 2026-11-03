import { AppButton, AppText } from "@linkdish/ui";
import { router } from "expo-router";
import React from "react";
import { StyleSheet, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { warn as warnHaptic } from "../../lib/haptics";
import { appSpacing } from "../../theme/tokens";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { useMealPlan } from "./MealPlanContext";
import { DayChips, ServingsStepper, SheetLabel, SlotChips } from "./PlanControls";
import { defaultServingsFor, getDayLabel, SLOT_LABELS, type MealPlanEntry } from "./store";

/**
 * One planned meal: open its recipe, move it to another day or meal, change its servings, or
 * take it off the plan. Every change saves as it is made.
 */
export const PlanEntrySheet = ({
  entry,
  onClose,
  today,
  weekDates
}: {
  /** The entry to show; the sheet is open while there is one. */
  entry: MealPlanEntry | null;
  onClose: () => void;
  today: string;
  /** The days it can move to (the week on screen). */
  weekDates: readonly string[];
}) => {
  const { removeEntry, updateEntry } = useMealPlan();
  const { getSavedRecipeById } = useSavedRecipes();
  const record = entry?.recipeId ? getSavedRecipeById(entry.recipeId) : undefined;
  const label = entry ? getDayLabel(entry.date) : null;
  const servings = entry?.servings ?? defaultServingsFor(record);

  return (
    <AppSheet
      description={
        entry && label
          ? `${label.weekdayLong}, ${label.monthDay} · ${SLOT_LABELS[entry.slot]}`
          : undefined
      }
      footer={
        entry ? (
          <View style={styles.footer}>
            {record ? (
              <AppButton
                label="Open recipe"
                onPress={() => {
                  onClose();
                  router.push({ pathname: "/recipe", params: { savedId: record.id } });
                }}
              />
            ) : null}
            <AppButton
              label="Remove from plan"
              onPress={() => {
                warnHaptic();
                removeEntry(entry.id);
                onClose();
              }}
              variant="outline-danger"
            />
          </View>
        ) : null
      }
      onClose={onClose}
      testID="plan-entry-sheet"
      title={entry?.title ?? ""}
      visible={entry != null}
    >
      {entry ? (
        <>
          {entry.recipeId && !record ? (
            <AppText muted style={styles.hint}>
              This recipe is no longer in your cookbook, so it adds nothing to shopping.
            </AppText>
          ) : null}
          <SheetLabel>Day</SheetLabel>
          <DayChips
            dates={weekDates.includes(entry.date) ? weekDates : [entry.date, ...weekDates]}
            onChange={(date) => updateEntry(entry.id, { date })}
            today={today}
            value={entry.date}
          />
          <SheetLabel>Meal</SheetLabel>
          <SlotChips onChange={(slot) => updateEntry(entry.id, { slot })} value={entry.slot} />
          {record && servings ? (
            <>
              <SheetLabel>Servings</SheetLabel>
              <ServingsStepper
                onChange={(next) => updateEntry(entry.id, { servings: next })}
                value={servings}
              />
              <AppText muted style={styles.hint}>
                Shopping for the week scales this recipe to these servings.
              </AppText>
            </>
          ) : null}
        </>
      ) : null}
    </AppSheet>
  );
};

const styles = StyleSheet.create({
  footer: {
    gap: appSpacing.sm
  },
  hint: {
    fontSize: 13,
    lineHeight: 18
  }
});
