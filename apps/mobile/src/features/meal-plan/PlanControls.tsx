import { MaterialCommunityIcons } from "@expo/vector-icons";
import { MEAL_SLOTS } from "@linkdish/recipe-domain";
import { AppText } from "@linkdish/ui";
import React from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { selectionTick } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { Chip } from "../collections/Chip";

import { getDayLabel, SLOT_LABELS, type MealPlanSlot } from "./store";

/** Breakfast, lunch, dinner or snack. */
export const SlotChips = ({
  onChange,
  value
}: {
  onChange: (slot: MealPlanSlot) => void;
  value: MealPlanSlot;
}) => (
  <View accessibilityLabel="Meal" style={styles.chips}>
    {MEAL_SLOTS.map((slot) => (
      <Chip
        key={slot}
        label={SLOT_LABELS[slot]}
        onPress={() => {
          selectionTick();
          onChange(slot);
        }}
        selected={slot === value}
        testID={`slot-${slot}`}
      />
    ))}
  </View>
);

/**
 * A row of days to pick from ("Today", "Tomorrow", "Thu 30"); days that already have something
 * planned get a dot.
 */
export const DayChips = ({
  dates,
  onChange,
  plannedDates,
  today,
  value
}: {
  dates: readonly string[];
  onChange: (date: string) => void;
  plannedDates?: ReadonlySet<string> | undefined;
  today: string;
  value: string;
}) => (
  <ScrollView
    contentContainerStyle={styles.dayRow}
    horizontal
    keyboardShouldPersistTaps="handled"
    showsHorizontalScrollIndicator={false}
  >
    {dates.map((date) => {
      const label = getDayLabel(date);
      const selected = date === value;

      return (
        <Pressable
          accessibilityLabel={`${date === today ? "Today, " : ""}${label.weekdayLong} ${label.monthDay}`}
          accessibilityRole="radio"
          accessibilityState={{ checked: selected }}
          key={date}
          onPress={() => {
            selectionTick();
            onChange(date);
          }}
          style={({ pressed }) => [
            styles.day,
            selected && styles.daySelected,
            pressed && styles.pressed
          ]}
          testID={`day-${date}`}
        >
          <AppText style={[styles.dayWeekday, selected && styles.dayTextSelected]}>
            {date === today ? "Today" : label.weekday}
          </AppText>
          <AppText style={[styles.dayNumber, selected && styles.dayTextSelected]}>
            {label.dayOfMonth}
          </AppText>
          <View
            style={[
              styles.dot,
              plannedDates?.has(date) ? null : styles.dotHidden,
              selected && styles.dotSelected
            ]}
          />
        </Pressable>
      );
    })}
  </ScrollView>
);

/** − 4 servings + */
export const ServingsStepper = ({
  onChange,
  value
}: {
  onChange: (servings: number) => void;
  value: number;
}) => (
  <View style={styles.stepper}>
    <StepButton
      disabled={value <= 1}
      icon="minus"
      label="Fewer servings"
      onPress={() => onChange(Math.max(1, Math.ceil(value) - 1))}
    />
    <AppText style={styles.stepperValue}>{value === 1 ? "1 serving" : `${value} servings`}</AppText>
    <StepButton
      disabled={value >= 99}
      icon="plus"
      label="More servings"
      onPress={() => onChange(Math.min(99, Math.floor(value) + 1))}
    />
  </View>
);

const StepButton = ({
  disabled,
  icon,
  label,
  onPress
}: {
  disabled: boolean;
  icon: "minus" | "plus";
  label: string;
  onPress: () => void;
}) => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    disabled={disabled}
    hitSlop={6}
    onPress={() => {
      selectionTick();
      onPress();
    }}
    style={({ pressed }) => [
      styles.stepButton,
      disabled && styles.stepButtonDisabled,
      pressed && styles.pressed
    ]}
  >
    <MaterialCommunityIcons color={appColors.accent} name={icon} size={18} />
  </Pressable>
);

export const SheetLabel = ({ children }: { children: string }) => (
  <AppText style={styles.label} variant="label">
    {children}
  </AppText>
);

const styles = StyleSheet.create({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: appSpacing.sm
  },
  day: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    gap: 2,
    minWidth: 58,
    paddingHorizontal: appSpacing.sm,
    paddingVertical: appSpacing.sm
  },
  dayNumber: {
    fontSize: 17,
    fontWeight: "700"
  },
  dayRow: {
    gap: appSpacing.sm
  },
  daySelected: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  dayTextSelected: {
    color: appColors.onAccent
  },
  dayWeekday: {
    fontSize: 12,
    fontWeight: "600"
  },
  dot: {
    backgroundColor: appColors.tomato,
    borderRadius: 3,
    height: 5,
    width: 5
  },
  dotHidden: {
    opacity: 0
  },
  dotSelected: {
    backgroundColor: appColors.onAccent
  },
  label: {
    fontSize: 12,
    letterSpacing: 0.6
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  stepButton: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  stepButtonDisabled: {
    opacity: 0.35
  },
  stepper: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md
  },
  stepperValue: {
    fontSize: 15,
    fontWeight: "600",
    minWidth: 92,
    textAlign: "center"
  }
});
