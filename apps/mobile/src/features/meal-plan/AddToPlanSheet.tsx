import { addDaysToIsoDate, toIsoDate } from "@linkdish/recipe-domain";
import { AppButton, AppText } from "@linkdish/ui";
import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppSheet } from "../../components/AppSheet";
import { success as successHaptic } from "../../lib/haptics";
import { appColors, appSpacing } from "../../theme/tokens";

import { useMealPlan } from "./MealPlanContext";
import { DayChips, ServingsStepper, SheetLabel, SlotChips } from "./PlanControls";
import {
  defaultServingsFor,
  relativeDayName,
  SLOT_LABELS,
  type MealPlanEntry,
  type MealPlanSlot
} from "./store";

import type { SavedRecipeRecord } from "../saved-recipes/store";

const DAYS_AHEAD = 14;

/**
 * "Add to plan" from a recipe, as on the web: one of the next 14 days, a meal and servings. Days
 * that already have something planned show a dot.
 */
export const AddToPlanSheet = ({
  onClose,
  record,
  visible
}: {
  onClose: () => void;
  record: SavedRecipeRecord;
  visible: boolean;
}) => {
  const { addEntry, entries } = useMealPlan();
  const [today, setToday] = useState(() => toIsoDate(new Date()));
  const dates = useMemo(
    () => Array.from({ length: DAYS_AHEAD }, (_unused, index) => addDaysToIsoDate(today, index)),
    [today]
  );
  const [date, setDate] = useState(today);
  const [slot, setSlot] = useState<MealPlanSlot>("dinner");
  const [servings, setServings] = useState(() => defaultServingsFor(record) ?? 4);
  const [added, setAdded] = useState<MealPlanEntry | null>(null);
  const wasVisibleRef = useRef(visible);
  const plannedDates = useMemo(() => new Set(entries.map((entry) => entry.date)), [entries]);
  const slotTaken = entries.some((entry) => entry.date === date && entry.slot === slot);

  // Each time the sheet opens: today's dinner at the recipe's own servings.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    if (visible && !wasVisible) {
      const now = toIsoDate(new Date());
      setToday(now);
      setDate(now);
      setSlot("dinner");
      setServings(defaultServingsFor(record) ?? 4);
      setAdded(null);
    }
  }, [record, visible]);

  const save = () => {
    const entry = addEntry(
      { date, recipeId: record.id, servings, slot, title: record.recipe.title },
      "recipe_page"
    );
    successHaptic();
    setAdded(entry);
  };

  const tomorrow = addDaysToIsoDate(today, 1);

  return (
    <AppSheet
      description={record.recipe.title}
      footer={
        added ? (
          <View style={styles.footerRow}>
            <AppButton
              label="Done"
              onPress={onClose}
              style={styles.footerButton}
              variant="outline"
            />
            <AppButton
              label="View plan"
              onPress={() => {
                onClose();
                router.push({ pathname: "/plan", params: { date: added.date } });
              }}
              style={styles.footerButton}
            />
          </View>
        ) : (
          <AppButton label="Add to plan" onPress={save} />
        )
      }
      onClose={onClose}
      testID="add-to-plan-sheet"
      title={added ? "Planned" : "Add to plan"}
      visible={visible}
    >
      {added ? (
        <AppText style={styles.done}>
          {`On the plan for ${describeDay(added.date, today, tomorrow)}'s ${SLOT_LABELS[added.slot].toLowerCase()}.`}
        </AppText>
      ) : (
        <>
          <SheetLabel>Day</SheetLabel>
          <DayChips
            dates={dates}
            onChange={setDate}
            plannedDates={plannedDates}
            today={today}
            value={date}
          />
          <SheetLabel>Meal</SheetLabel>
          <SlotChips onChange={setSlot} value={slot} />
          {slotTaken ? (
            <AppText muted style={styles.hint}>
              Something is already planned for this meal. This will sit alongside it.
            </AppText>
          ) : null}
          <SheetLabel>Servings</SheetLabel>
          <ServingsStepper onChange={setServings} value={servings} />
        </>
      )}
    </AppSheet>
  );
};

/** "today", "tomorrow" or "Thursday", mid-sentence. */
const describeDay = (date: string, today: string, tomorrow: string): string => {
  const name = relativeDayName(date, today, tomorrow);
  return date === today || date === tomorrow ? name.toLowerCase() : name;
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
  hint: {
    fontSize: 13,
    lineHeight: 18
  }
});
