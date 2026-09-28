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
  value: string;
}

/** The hero's meta strip: total, prep and cook time plus the (scaled) yield. */
export const getRecipeMetaItems = (
  recipe: Pick<Recipe, "prepTimeMinutes" | "cookTimeMinutes" | "totalTimeMinutes">,
  servingsLabel: string
): RecipeMetaItem[] => {
  const times = getRecipeTimes(recipe);
  const items: RecipeMetaItem[] = [];
  const hasBothParts = times.labels.prep != null && times.labels.cook != null;

  // A total equal to a single known part says nothing new.
  if (times.labels.total && (hasBothParts || recipe.totalTimeMinutes != null)) {
    items.push({ id: "total", label: "Total", value: times.labels.total });
  }

  if (times.labels.prep) {
    items.push({ id: "prep", label: "Prep", value: times.labels.prep });
  }

  if (times.labels.cook) {
    items.push({ id: "cook", label: "Cook", value: times.labels.cook });
  }

  const servings = servingsLabel.trim();

  if (servings) {
    const match = servings.match(/^Serves\s+(.+)$/u);
    items.push(
      match?.[1]
        ? { id: "serves", label: "Serves", value: match[1].replace(/\s·.*$/u, "") }
        : { id: "serves", label: "Makes", value: servings.replace(/^Makes\s+/u, "") }
    );
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
