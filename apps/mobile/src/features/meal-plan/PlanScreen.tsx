import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  addDaysToIsoDate,
  groupEntriesByDay,
  startOfWeek,
  toIsoDate,
  weekDays
} from "@linkdish/recipe-domain";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { selectionTick } from "../../lib/haptics";
import { pressedOpacity } from "../../theme/interactions";
import { appColors, appSpacing } from "../../theme/tokens";
import { useTabBarScroll } from "../navigation/TabBarVisibility";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import { useMealPlan } from "./MealPlanContext";
import { PlanEntrySheet } from "./PlanEntrySheet";
import { PlanMealSheet } from "./PlanMealSheet";
import { PlanShoppingSheet } from "./PlanShoppingSheet";
import {
  formatServingsLabel,
  formatWeekRange,
  getDayLabel,
  getWeekTitle,
  isValidIsoDate,
  noteIconFor,
  SLOT_LABELS,
  type MealPlanEntry
} from "./store";

import type { SavedRecipeRecord } from "../saved-recipes/store";

/**
 * The Plan tab: one week at a time, a card per day with its meals. Tap a day's + to plan a recipe
 * or a note, tap a meal to move, rescale or remove it, and turn the week into a shopping list.
 */
export const PlanScreen = () => {
  const onTabScroll = useTabBarScroll();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ date?: string }>();
  const { entries, hasLoadedMealPlan, isMealPlanReadable, setWeekStartsOn, weekStartsOn } =
    useMealPlan();
  const { savedRecipes } = useSavedRecipes();
  const [today, setToday] = useState(() => toIsoDate(new Date()));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(today, weekStartsOn));
  const [addingDate, setAddingDate] = useState<string | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [isShopping, setIsShopping] = useState(false);
  const currentWeekStart = startOfWeek(today, weekStartsOn);
  const todayRef = useRef(today);
  todayRef.current = today;

  // The day can turn over while the app sits in the background (on this tab or another): the
  // week with today in it moves on with it.
  const refreshToday = useCallback(() => {
    const previous = todayRef.current;
    const next = toIsoDate(new Date());

    if (next === previous) {
      return;
    }

    todayRef.current = next;
    setToday(next);
    setWeekStart((current) =>
      previous >= current && previous <= addDaysToIsoDate(current, 6)
        ? startOfWeek(next, weekStartsOn)
        : current
    );
  }, [weekStartsOn]);

  useFocusEffect(refreshToday);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshToday();
      }
    });

    return () => subscription.remove();
  }, [refreshToday]);

  // "View plan" after planning a recipe opens the week it went on.
  const requestedDate = typeof params.date === "string" ? params.date : undefined;
  useEffect(() => {
    if (requestedDate && isValidIsoDate(requestedDate)) {
      setWeekStart(startOfWeek(requestedDate, weekStartsOn));
    }
  }, [requestedDate, weekStartsOn]);

  // Changing the first day of the week (or loading the saved choice) keeps the same week in view:
  // the week with today in it if that was showing, otherwise the one around the old week's middle
  // (rounding its old first day would land on the week before).
  useEffect(() => {
    setWeekStart((current) => {
      const today = todayRef.current;
      const showsToday = today >= current && today <= addDaysToIsoDate(current, 6);
      return startOfWeek(showsToday ? today : addDaysToIsoDate(current, 3), weekStartsOn);
    });
  }, [weekStartsOn]);

  const dates = useMemo(() => weekDays(weekStart), [weekStart]);
  const weekEntries = useMemo(
    () => entries.filter((entry) => entry.date >= dates[0]! && entry.date <= dates[6]!),
    [dates, entries]
  );
  const days = useMemo(() => groupEntriesByDay(weekEntries, dates), [dates, weekEntries]);
  const recipesById = useMemo(
    () => new Map<string, SavedRecipeRecord>(savedRecipes.map((record) => [record.id, record])),
    [savedRecipes]
  );
  const hasRecipes = weekEntries.some((entry) => entry.recipeId && recipesById.has(entry.recipeId));
  const openEntry = entries.find((entry) => entry.id === openEntryId) ?? null;
  const weekLabel = formatWeekRange(dates);

  const moveWeek = (offset: number) => {
    selectionTick();
    setWeekStart((current) => addDaysToIsoDate(current, offset * 7));
  };

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.screen}>
      <ScrollView
        onScroll={onTabScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, appSpacing.xl) + 100 }
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <AppText style={styles.title} variant="display">
              {getWeekTitle(weekStart, currentWeekStart, addDaysToIsoDate)}
            </AppText>
            <AppText muted style={styles.subtitle}>
              {weekLabel}
            </AppText>
          </View>
          <WeekButton icon="chevron-left" label="Previous week" onPress={() => moveWeek(-1)} />
          <WeekButton icon="chevron-right" label="Next week" onPress={() => moveWeek(1)} />
        </View>

        <View style={styles.toolbar}>
          {weekStart !== currentWeekStart ? (
            <AppButton
              label="Back to this week"
              onPress={() => setWeekStart(currentWeekStart)}
              style={styles.toolbarButton}
              variant="outline"
            />
          ) : null}
          <AppButton
            disabled={!hasRecipes}
            label="Shop for the week"
            onPress={() => setIsShopping(true)}
            style={styles.toolbarButton}
            variant={hasRecipes ? "primary" : "outline"}
          />
        </View>

        {!hasLoadedMealPlan ? <AppText muted>Loading your plan...</AppText> : null}

        {/* A plan that couldn't be read isn't saved to, so nothing can be planned over it. */}
        {hasLoadedMealPlan && !isMealPlanReadable ? (
          <AppSurface style={styles.unreadable}>
            <AppText muted>
              Your meal plan couldn&apos;t be loaded on this phone, so planning is paused to keep it
              safe. Close and reopen LinkDish to try again.
            </AppText>
          </AppSurface>
        ) : (
          days.map((day) => (
            <DayCard
              date={day.date}
              entries={day.entries}
              isToday={day.date === today}
              key={day.date}
              onAdd={() => setAddingDate(day.date)}
              onOpenEntry={(entry) => setOpenEntryId(entry.id)}
              recipesById={recipesById}
            />
          ))
        )}

        <Pressable
          accessibilityHint="Changes which day each week starts on"
          accessibilityRole="button"
          onPress={() => setWeekStartsOn(weekStartsOn === 0 ? 1 : 0)}
          style={({ pressed }) => [styles.weekStart, pressed && styles.pressed]}
          testID="plan-week-start"
        >
          <AppText muted style={styles.weekStartText}>
            {`Weeks start on ${weekStartsOn === 0 ? "Sunday" : "Monday"} · `}
            <AppText style={styles.weekStartLink}>
              {`Start on ${weekStartsOn === 0 ? "Monday" : "Sunday"}`}
            </AppText>
          </AppText>
        </Pressable>
      </ScrollView>

      {addingDate ? (
        <PlanMealSheet
          date={addingDate}
          dayEntries={entries.filter((entry) => entry.date === addingDate)}
          onClose={() => setAddingDate(null)}
          visible
        />
      ) : null}
      {openEntry ? (
        <PlanEntrySheet
          entry={openEntry}
          onClose={() => setOpenEntryId(null)}
          today={today}
          weekDates={dates}
        />
      ) : null}
      {isShopping ? (
        <PlanShoppingSheet
          entries={weekEntries}
          onClose={() => setIsShopping(false)}
          recipesById={recipesById}
          visible
          weekLabel={weekLabel}
        />
      ) : null}
    </SafeAreaView>
  );
};

const WeekButton = ({
  icon,
  label,
  onPress
}: {
  icon: "chevron-left" | "chevron-right";
  label: string;
  onPress: () => void;
}) => (
  <Pressable
    accessibilityLabel={label}
    accessibilityRole="button"
    hitSlop={6}
    onPress={onPress}
    style={({ pressed }) => [styles.weekButton, pressed && styles.pressed]}
  >
    <MaterialCommunityIcons color={appColors.accent} name={icon} size={24} />
  </Pressable>
);

const DayCard = ({
  date,
  entries,
  isToday,
  onAdd,
  onOpenEntry,
  recipesById
}: {
  date: string;
  entries: readonly MealPlanEntry[];
  isToday: boolean;
  onAdd: () => void;
  onOpenEntry: (entry: MealPlanEntry) => void;
  recipesById: ReadonlyMap<string, SavedRecipeRecord>;
}) => {
  const label = getDayLabel(date);

  return (
    <AppSurface style={[styles.day, isToday && styles.dayToday]}>
      <View style={styles.dayHeader}>
        <AppText style={styles.dayTitle} variant="title">
          {label.weekdayLong}
        </AppText>
        <AppText muted style={styles.dayDate}>
          {isToday ? `Today · ${label.monthDay}` : label.monthDay}
        </AppText>
        <Pressable
          accessibilityLabel={`Add a meal on ${label.weekdayLong}`}
          accessibilityRole="button"
          hitSlop={6}
          onPress={onAdd}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
          testID={`plan-add-${date}`}
        >
          <MaterialCommunityIcons color={appColors.accent} name="plus" size={20} />
        </Pressable>
      </View>

      {entries.length === 0 ? (
        <AppText muted style={styles.dayEmpty}>
          Nothing planned
        </AppText>
      ) : (
        <View style={styles.entries}>
          {entries.map((entry) => {
            const hasRecipe = Boolean(entry.recipeId && recipesById.has(entry.recipeId));
            const meta = [
              SLOT_LABELS[entry.slot],
              hasRecipe && entry.servings ? formatServingsLabel(entry.servings) : undefined
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <Pressable
                accessibilityHint="Move, rescale or remove this meal"
                accessibilityLabel={`${SLOT_LABELS[entry.slot]}: ${entry.title}`}
                accessibilityRole="button"
                key={entry.id}
                onPress={() => onOpenEntry(entry)}
                style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
                testID={`plan-entry-${entry.id}`}
              >
                <View style={[styles.entryIcon, !entry.recipeId && styles.entryIconNote]}>
                  <MaterialCommunityIcons
                    color={entry.recipeId ? appColors.accent : appColors.onButterSoft}
                    name={entry.recipeId ? "silverware-variant" : noteIconFor(entry.title)}
                    size={17}
                  />
                </View>
                <View style={styles.entryCopy}>
                  <AppText numberOfLines={2} style={styles.entryTitle}>
                    {entry.title}
                  </AppText>
                  <AppText muted style={styles.entryMeta}>
                    {meta}
                  </AppText>
                </View>
                <MaterialCommunityIcons color={appColors.muted} name="chevron-right" size={20} />
              </Pressable>
            );
          })}
        </View>
      )}
    </AppSurface>
  );
};

const styles = StyleSheet.create({
  addButton: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34
  },
  content: {
    alignSelf: "center",
    gap: appSpacing.md,
    maxWidth: 760,
    padding: appSpacing.lg,
    width: "100%"
  },
  day: {
    gap: appSpacing.sm
  },
  dayDate: {
    flex: 1,
    fontSize: 14
  },
  dayEmpty: {
    fontSize: 14
  },
  dayHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.sm
  },
  dayTitle: {
    fontSize: 18
  },
  dayToday: {
    borderColor: appColors.accent,
    borderWidth: 1.5
  },
  entries: {
    gap: appSpacing.xs
  },
  entry: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md,
    minHeight: 48
  },
  entryCopy: {
    flex: 1,
    gap: 1
  },
  entryIcon: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 10,
    height: 32,
    justifyContent: "center",
    width: 32
  },
  entryIconNote: {
    backgroundColor: appColors.butterSoft
  },
  entryMeta: {
    fontSize: 12
  },
  entryTitle: {
    fontSize: 15,
    fontWeight: "600"
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.xs
  },
  headerCopy: {
    flex: 1,
    gap: 2
  },
  pressed: {
    opacity: pressedOpacity.medium
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  subtitle: {
    fontSize: 15
  },
  title: {
    fontSize: 34,
    lineHeight: 40
  },
  toolbar: {
    flexDirection: "row",
    gap: appSpacing.sm
  },
  toolbarButton: {
    flex: 1,
    minHeight: 44
  },
  unreadable: {
    padding: appSpacing.lg
  },
  weekButton: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  weekStart: {
    alignItems: "center",
    minHeight: 44,
    justifyContent: "center"
  },
  weekStartLink: {
    color: appColors.accent,
    fontSize: 13,
    fontWeight: "700"
  },
  weekStartText: {
    fontSize: 13
  }
});
