import { parseServings } from "@linkdish/recipe-domain";

import { addDaysToDateKey, getDateKeyRange, getWeekStartDateKey } from "../../data/date-keys";

import type { IconName } from "../../components/Icon";
import type { MealPlanEntry, MealPlanSlot } from "../../data/meal-plan-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

/** Calendar helpers, labels and ranking for the planner. Pure; dates are "YYYY-MM-DD" keys. */

export const SLOT_LABELS: Record<MealPlanSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack"
};

export const SLOT_OPTIONS = (["breakfast", "lunch", "dinner", "snack"] as const).map((slot) => ({
  label: SLOT_LABELS[slot],
  value: slot
}));

export const NOTE_PRESETS: ReadonlyArray<{ title: string; icon: IconName }> = [
  { icon: "cooking-pot", title: "Leftovers" },
  { icon: "utensils", title: "Eat out" },
  { icon: "shopping-basket", title: "Takeout" }
];

/** Icon for an entry without a recipe ("Leftovers" → pot). */
export const noteIconFor = (title: string): IconName => {
  const lowered = title.toLocaleLowerCase();

  if (lowered.includes("leftover")) {
    return "cooking-pot";
  }

  if (
    lowered.includes("eat out") ||
    lowered.includes("restaurant") ||
    lowered.includes("dinner out")
  ) {
    return "utensils";
  }

  if (lowered.includes("takeout") || lowered.includes("take-out") || lowered.includes("delivery")) {
    return "shopping-basket";
  }

  return "sticky-note";
};

/** Local Date for a date key (midnight, device time zone). */
export const dateFromKey = (key: string): Date => {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};

const formatter = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, options);

const weekdayShort = formatter({ weekday: "short" });
const weekdayLong = formatter({ weekday: "long" });
const monthDay = formatter({ day: "numeric", month: "short" });
const longDate = formatter({ day: "numeric", month: "long", weekday: "long" });

export interface DayLabel {
  key: string;
  weekday: string;
  weekdayLong: string;
  dayOfMonth: string;
  /** "Sep 28" */
  monthDay: string;
  /** "Monday, September 28" */
  long: string;
}

export const getDayLabel = (key: string): DayLabel => {
  const date = dateFromKey(key);

  return {
    dayOfMonth: String(date.getDate()),
    key,
    long: longDate.format(date),
    monthDay: monthDay.format(date),
    weekday: weekdayShort.format(date),
    weekdayLong: weekdayLong.format(date)
  };
};

/** "Today", "Tomorrow", or the weekday name, for toasts and buttons. */
export const relativeDayName = (key: string, todayKey: string): string => {
  if (key === todayKey) {
    return "today";
  }

  if (key === addDaysToDateKey(todayKey, 1)) {
    return "tomorrow";
  }

  return getDayLabel(key).weekdayLong;
};

export const getWeekDates = (weekStart: string): string[] => getDateKeyRange(weekStart, 7);

export const weekStartFor = (key: string, weekStartsOn: 0 | 1): string =>
  getWeekStartDateKey(key, weekStartsOn);

/** "Sep 28 – Oct 4" */
export const formatWeekRange = (weekStart: string): string =>
  `${getDayLabel(weekStart).monthDay} – ${getDayLabel(addDaysToDateKey(weekStart, 6)).monthDay}`;

/** Page title for a week relative to this one: "This *week*", "Next *week*", "Week of *Oct 12*". */
export const getWeekTitle = (
  weekStart: string,
  currentWeekStart: string
): { title: string; accent: string } => {
  if (weekStart === currentWeekStart) {
    return { accent: "week", title: "This" };
  }

  if (weekStart === addDaysToDateKey(currentWeekStart, 7)) {
    return { accent: "week", title: "Next" };
  }

  if (weekStart === addDaysToDateKey(currentWeekStart, -7)) {
    return { accent: "week", title: "Last" };
  }

  return { accent: getDayLabel(weekStart).monthDay, title: "Week of" };
};

/** The servings a recipe is usually made for (the cook's preference, else the recipe's yield). */
export const defaultServingsFor = (recipe: WebSavedRecipe | undefined): number | undefined => {
  if (!recipe) {
    return undefined;
  }

  if (recipe.preferredServings && recipe.preferredServings > 0) {
    return recipe.preferredServings;
  }

  return parseServings(recipe.recipe.servings)?.min;
};

const timeOf = (value: string | undefined): number => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

/**
 * Picker order: favorites first, then recently and often cooked, then recently opened, then
 * everything else by title.
 */
export const rankRecipesForPlanning = (recipes: readonly WebSavedRecipe[]): WebSavedRecipe[] =>
  recipes
    .map((recipe) => ({
      recipe,
      score:
        (recipe.favorite ? 1_000 : 0) +
        Math.min(recipe.timesCooked ?? 0, 50) * 8 +
        (recipe.lastCookedAt
          ? 120 - Math.min(120, (Date.now() - timeOf(recipe.lastCookedAt)) / 86_400_000)
          : 0) +
        (recipe.lastOpenedAt ? 20 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.recipe.recipe.title.localeCompare(b.recipe.recipe.title))
    .map((entry) => entry.recipe);

/** Short context for a picker row: "Favorite · cooked 3×". */
export const describeRecipeForPicker = (recipe: WebSavedRecipe): string => {
  const parts: string[] = [];
  const cooked = recipe.timesCooked ?? 0;

  if (cooked > 0) {
    parts.push(`Cooked ${cooked}×`);
  }

  const total =
    recipe.recipe.totalTimeMinutes ??
    ((recipe.recipe.prepTimeMinutes ?? 0) + (recipe.recipe.cookTimeMinutes ?? 0) || null);

  if (total) {
    parts.push(
      total >= 60
        ? `${Math.floor(total / 60)} hr${total % 60 ? ` ${total % 60} min` : ""}`
        : `${total} min`
    );
  }

  if (parts.length === 0 && recipe.sourceHost) {
    parts.push(recipe.sourceHost);
  }

  return parts.join(" · ");
};

/**
 * The next nights (from `fromKey`, within `dates`) with no dinner planned, in order.
 */
export const findOpenDinnerDates = (
  dates: readonly string[],
  entries: readonly Pick<MealPlanEntry, "date" | "slot">[],
  fromKey: string
): string[] => {
  const planned = new Set(
    entries.filter((entry) => entry.slot === "dinner").map((entry) => entry.date)
  );
  return dates.filter((date) => date >= fromKey && !planned.has(date));
};

/** The slot a new entry on a day most likely wants: dinner unless it is taken. */
export const suggestSlot = (dayEntries: readonly Pick<MealPlanEntry, "slot">[]): MealPlanSlot => {
  const taken = new Set(dayEntries.map((entry) => entry.slot));
  return (
    (["dinner", "lunch", "breakfast", "snack"] as const).find((slot) => !taken.has(slot)) ??
    "dinner"
  );
};

export const PLAN_ENTRY_DRAG_TYPE = "application/x-linkdish-plan-entry";
