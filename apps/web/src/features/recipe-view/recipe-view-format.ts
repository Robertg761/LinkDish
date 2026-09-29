import { getRecipeTimes } from "@linkdish/recipe-domain";

import type { Recipe } from "@linkdish/recipe-domain";

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (time: number): number => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** "today", "yesterday", "3 days ago", "2 weeks ago", "last month", "5 months ago". */
export const formatRelativeDay = (iso: string | null | undefined, now: number = Date.now()) => {
  const time = iso ? Date.parse(iso) : Number.NaN;

  if (!Number.isFinite(time)) {
    return "";
  }

  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);

  if (days <= 0) {
    return "today";
  }

  if (days === 1) {
    return "yesterday";
  }

  if (days < 7) {
    return `${days} days ago`;
  }

  if (days < 14) {
    return "last week";
  }

  if (days < 31) {
    return `${Math.floor(days / 7)} weeks ago`;
  }

  if (days < 60) {
    return "last month";
  }

  if (days < 365) {
    return `${Math.floor(days / 30)} months ago`;
  }

  return days < 730 ? "last year" : `${Math.floor(days / 365)} years ago`;
};

/** "Cooked 3× · last 2 weeks ago", "Cooked once · yesterday", or "" when never cooked. */
export const formatCookedLine = (
  timesCooked: number | null | undefined,
  lastCookedAt: string | null | undefined,
  now: number = Date.now()
): string => {
  const count = timesCooked ?? 0;

  if (count <= 0) {
    return "";
  }

  const when = formatRelativeDay(lastCookedAt, now);
  const times = count === 1 ? "Cooked once" : `Cooked ${count}×`;
  if (!when) {
    return times;
  }

  // "today", "yesterday", "last week" read on their own; "2 weeks ago" gets a "last".
  const standalone = when === "today" || when === "yesterday" || when.startsWith("last ");
  return `${times} · ${standalone ? when : `last ${when}`}`;
};

export interface RecipeMetaItem {
  id: "total" | "prep" | "cook" | "serves";
  label: string;
  /** Short enough for a quarter of a phone's width ("1h 30m", "24"). */
  value: string;
  /** The same value spelled out for screen readers ("1 hr 30 min"), when it differs. */
  spokenValue?: string | undefined;
}

/**
 * Stat-strip durations stay on one line: "45 min" and "2 hr" as usual, but "1h 30m" (and
 * "1d 2h") when a time has two parts, which used to wrap into a ragged, taller row.
 */
export const formatCompactDuration = (minutes: number): string => {
  const rounded = Math.max(0, Math.round(minutes));
  const days = Math.floor(rounded / 1440);
  const hours = Math.floor((rounded % 1440) / 60);
  const mins = rounded % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days} ${days === 1 ? "day" : "days"}`;
  }

  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours} hr`;
  }

  return `${mins} min`;
};

/** Longest counted noun shown as the yield's label ("Cookies 36"); longer ones read "Makes". */
const MAX_YIELD_NOUN_LENGTH = 12;
const YIELD_COUNT_PATTERN = /^(\S*\d[\d¼½¾⅓⅔.,]*(?:\s*[–-]\s*\S*\d[\d¼½¾⅓⅔.,]*)?)\s+(.+)$/u;

const capitalize = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** "Serves 8" → Serves · 8; "24 cookies" → Cookies · 24; "Makes 12" → Makes · 12. */
const getYieldItem = (servingsLabel: string): RecipeMetaItem => {
  const serves = servingsLabel.match(/^Serves\s+(.+)$/u);

  if (serves?.[1]) {
    return { id: "serves", label: "Serves", value: serves[1].replace(/\s·.*$/u, "") };
  }

  const made = servingsLabel.replace(/^Makes\s+/u, "");
  const counted = made.match(YIELD_COUNT_PATTERN);
  const count = counted?.[1];
  const noun = counted?.[2]?.trim();

  if (count && noun && noun.length <= MAX_YIELD_NOUN_LENGTH) {
    return { id: "serves", label: capitalize(noun), value: count, spokenValue: made };
  }

  return count && noun
    ? { id: "serves", label: "Makes", value: count, spokenValue: made }
    : { id: "serves", label: "Makes", value: made };
};

/** The hero's meta strip: total, prep and cook time plus the (scaled) yield. */
export const getRecipeMetaItems = (
  recipe: Pick<Recipe, "prepTimeMinutes" | "cookTimeMinutes" | "totalTimeMinutes">,
  servingsLabel: string
): RecipeMetaItem[] => {
  const times = getRecipeTimes(recipe);
  const items: RecipeMetaItem[] = [];
  const hasBothParts = times.labels.prep != null && times.labels.cook != null;
  const timeItem = (
    id: "total" | "prep" | "cook",
    label: string,
    minutes: number | null,
    spoken: string | null
  ) => {
    if (minutes == null || !spoken) {
      return;
    }

    const value = formatCompactDuration(minutes);
    items.push({ id, label, value, ...(value === spoken ? {} : { spokenValue: spoken }) });
  };

  // A total equal to a single known part says nothing new.
  if (times.labels.total && (hasBothParts || recipe.totalTimeMinutes != null)) {
    timeItem("total", "Total", times.total, times.labels.total);
  }

  timeItem("prep", "Prep", times.prep, times.labels.prep);
  timeItem("cook", "Cook", times.cook, times.labels.cook);

  const servings = servingsLabel.trim();

  if (servings) {
    items.push(getYieldItem(servings));
  }

  return items;
};

export const NUTRITION_ROWS = [
  ["Calories", "calories"],
  ["Protein", "protein"],
  ["Carbs", "carbohydrates"],
  ["Fat", "fat"],
  ["Fiber", "fiber"],
  ["Sugar", "sugar"],
  ["Sodium", "sodium"]
] as const;

export const getNutritionEntries = (nutrition: Recipe["nutrition"]) =>
  NUTRITION_ROWS.flatMap(([label, key]) => {
    const value = nutrition?.[key];
    return value != null && value !== "" ? [{ key, label, value }] : [];
  });
