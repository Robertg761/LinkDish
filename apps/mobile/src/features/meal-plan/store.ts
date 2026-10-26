import {
  buildShoppingInputsForPlan,
  formatShoppingItemText,
  getUnitDefinition,
  inferRecipeTags,
  MEAL_SLOTS,
  mergeShoppingInputs,
  parseServings
} from "@linkdish/recipe-domain";

import { getRecipeTags } from "../saved-recipes/collections";

import type { SavedRecipeRecord } from "../saved-recipes/store";
import type { AddShoppingItemInput, ShoppingUnitMode } from "../shopping/store";
import type { MaterialCommunityIcons } from "@expo/vector-icons";
import type {
  AggregatedShoppingItem,
  MealSlot,
  Recipe,
  RecipeCourse,
  ShoppingQuantity
} from "@linkdish/recipe-domain";
import type { ComponentProps } from "react";

/**
 * The weekly meal plan, as the web app has it: entries on a calendar day ("YYYY-MM-DD") and
 * slot, optionally pointing at a saved recipe. The title is kept so the plan still reads well if
 * the recipe is deleted. Local to this device, like on the web.
 */

export const MEAL_PLAN_STORAGE_KEY = "linkdish.mealPlan.v1";

export type MealPlanSlot = MealSlot;

export interface MealPlanEntry {
  id: string;
  /** Calendar day, "YYYY-MM-DD". */
  date: string;
  slot: MealPlanSlot;
  recipeId?: string | undefined;
  title: string;
  servings?: number | undefined;
  note?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface MealPlanEntryInput {
  date: string;
  slot: MealPlanSlot;
  recipeId?: string | undefined;
  title: string;
  servings?: number | undefined;
  note?: string | undefined;
}

export type MealPlanEntryPatch = Partial<
  Omit<MealPlanEntryInput, "recipeId" | "servings" | "note"> & {
    recipeId: string | null;
    servings: number | null;
    note: string | null;
  }
>;

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const MAX_TITLE_LENGTH = 200;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A real calendar day written "YYYY-MM-DD" (no "2026-02-30"). */
export const isValidIsoDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
};
const MAX_NOTE_LENGTH = 500;

export class MealPlanValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MealPlanValidationError";
  }
}

export const isMealPlanSlot = (value: unknown): value is MealPlanSlot =>
  typeof value === "string" && (MEAL_SLOTS as readonly string[]).includes(value);

const assertDate = (date: string): string => {
  if (!isValidIsoDate(date)) {
    throw new MealPlanValidationError("Pick a day for this meal.");
  }

  return date;
};

const assertSlot = (slot: string): MealPlanSlot => {
  if (!isMealPlanSlot(slot)) {
    throw new MealPlanValidationError("Pick breakfast, lunch, dinner or a snack.");
  }

  return slot;
};

const cleanTitle = (title: string): string => {
  const cleaned = title.trim().replace(/\s+/gu, " ").slice(0, MAX_TITLE_LENGTH);

  if (!cleaned) {
    throw new MealPlanValidationError("Give this meal a name.");
  }

  return cleaned;
};

const cleanServings = (servings: number | null | undefined): number | undefined =>
  servings != null && Number.isFinite(servings) && servings > 0
    ? Math.round(servings * 100) / 100
    : undefined;

const cleanNote = (note: string | null | undefined): string | undefined => {
  const cleaned = note?.trim().slice(0, MAX_NOTE_LENGTH);
  return cleaned || undefined;
};

const slotOrder = (slot: MealPlanSlot): number => MEAL_SLOTS.indexOf(slot);

/** Day, then slot (breakfast → snack), then the order entries were added. */
export const compareMealPlanEntries = (a: MealPlanEntry, b: MealPlanEntry): number =>
  a.date.localeCompare(b.date) ||
  slotOrder(a.slot) - slotOrder(b.slot) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

const createEntryId = (date: Date): string =>
  `plan-${date.getTime()}-${Math.random().toString(36).slice(2, 10)}`;

/** A new entry. Throws MealPlanValidationError on a bad day, slot or title. */
export const createMealPlanEntry = (input: MealPlanEntryInput, now = new Date()): MealPlanEntry => {
  const stamp = now.toISOString();
  const recipeId = input.recipeId?.trim();
  const servings = cleanServings(input.servings);
  const note = cleanNote(input.note);

  return {
    createdAt: stamp,
    date: assertDate(input.date),
    id: createEntryId(now),
    slot: assertSlot(input.slot),
    title: cleanTitle(input.title),
    updatedAt: stamp,
    ...(recipeId ? { recipeId } : {}),
    ...(servings ? { servings } : {}),
    ...(note ? { note } : {})
  };
};

/**
 * Changes only the fields in `patch` (`null` clears an optional one). Throws
 * MealPlanValidationError on a bad day, slot or title.
 */
export const updateMealPlanEntryRecord = (
  entry: MealPlanEntry,
  patch: MealPlanEntryPatch,
  now = new Date()
): MealPlanEntry => {
  const next: MealPlanEntry = {
    ...entry,
    ...(patch.date !== undefined ? { date: assertDate(patch.date) } : {}),
    ...(patch.slot !== undefined ? { slot: assertSlot(patch.slot) } : {}),
    ...(patch.title !== undefined ? { title: cleanTitle(patch.title) } : {}),
    updatedAt: now.toISOString()
  };

  if (patch.recipeId !== undefined) {
    next.recipeId = patch.recipeId?.trim() || undefined;
  }

  if (patch.servings !== undefined) {
    next.servings = cleanServings(patch.servings);
  }

  if (patch.note !== undefined) {
    next.note = cleanNote(patch.note);
  }

  for (const key of ["recipeId", "servings", "note"] as const) {
    if (!next[key]) {
      delete next[key];
    }
  }

  return next;
};

const isString = (value: unknown): value is string => typeof value === "string";

/** Reads the stored plan; anything unreadable is left out. */
export const parseMealPlan = (serialized: string | null): MealPlanEntry[] => {
  if (!serialized) {
    return [];
  }

  try {
    const parsed = JSON.parse(serialized) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .flatMap((value): MealPlanEntry[] => {
        const candidate = value as Partial<Record<keyof MealPlanEntry, unknown>> | null;

        if (
          !candidate ||
          !isString(candidate.id) ||
          !isString(candidate.date) ||
          !isValidIsoDate(candidate.date) ||
          !isMealPlanSlot(candidate.slot) ||
          !isString(candidate.title) ||
          !candidate.title.trim() ||
          !isString(candidate.createdAt)
        ) {
          return [];
        }

        const servings =
          typeof candidate.servings === "number" ? cleanServings(candidate.servings) : undefined;

        return [
          {
            createdAt: candidate.createdAt,
            date: candidate.date,
            id: candidate.id,
            slot: candidate.slot,
            title: candidate.title,
            updatedAt: isString(candidate.updatedAt) ? candidate.updatedAt : candidate.createdAt,
            ...(isString(candidate.recipeId) && candidate.recipeId
              ? { recipeId: candidate.recipeId }
              : {}),
            ...(servings ? { servings } : {}),
            ...(isString(candidate.note) && candidate.note ? { note: candidate.note } : {})
          }
        ];
      })
      .sort(compareMealPlanEntries);
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------------------------------- */

export const SLOT_LABELS: Record<MealPlanSlot, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack"
};

export const NOTE_PRESETS: ReadonlyArray<{ icon: IconName; title: string }> = [
  { icon: "pot-steam-outline", title: "Leftovers" },
  { icon: "silverware-fork-knife", title: "Eat out" },
  { icon: "shopping-outline", title: "Takeout" }
];

/** Icon for an entry without a recipe ("Leftovers" → pot). */
export const noteIconFor = (title: string): IconName => {
  const lowered = title.toLocaleLowerCase();

  if (lowered.includes("leftover")) {
    return "pot-steam-outline";
  }

  if (
    lowered.includes("eat out") ||
    lowered.includes("restaurant") ||
    lowered.includes("dinner out")
  ) {
    return "silverware-fork-knife";
  }

  if (lowered.includes("takeout") || lowered.includes("take-out") || lowered.includes("delivery")) {
    return "shopping-outline";
  }

  return "note-text-outline";
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface DayLabel {
  /** "28" */
  dayOfMonth: string;
  /** "Sep 28" */
  monthDay: string;
  /** "Mon" */
  weekday: string;
  /** "Monday" */
  weekdayLong: string;
}

/** Labels for a "YYYY-MM-DD" day (English, like the rest of the app). */
export const getDayLabel = (date: string): DayLabel => {
  const [year, month, day] = date.split("-").map(Number);
  const weekday =
    WEEKDAYS[new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay()];

  return {
    dayOfMonth: String(day ?? ""),
    monthDay: `${MONTHS[(month ?? 1) - 1] ?? ""} ${day ?? ""}`,
    weekday: (weekday ?? "").slice(0, 3),
    weekdayLong: weekday ?? ""
  };
};

/** "Today", "Tomorrow", or the weekday name ("Thursday"). */
export const relativeDayName = (date: string, today: string, tomorrow: string): string =>
  date === today ? "Today" : date === tomorrow ? "Tomorrow" : getDayLabel(date).weekdayLong;

/** "Sep 28 – Oct 4" */
export const formatWeekRange = (weekDates: readonly string[]): string => {
  const first = weekDates[0];
  const last = weekDates[weekDates.length - 1];
  return first && last ? `${getDayLabel(first).monthDay} – ${getDayLabel(last).monthDay}` : "";
};

/** "This week", "Next week", "Last week", or "Week of Oct 12". */
export const getWeekTitle = (
  weekStart: string,
  currentWeekStart: string,
  addDays: (date: string, days: number) => string
): string => {
  if (weekStart === currentWeekStart) {
    return "This week";
  }

  if (weekStart === addDays(currentWeekStart, 7)) {
    return "Next week";
  }

  if (weekStart === addDays(currentWeekStart, -7)) {
    return "Last week";
  }

  return `Week of ${getDayLabel(weekStart).monthDay}`;
};

export const formatServingsLabel = (servings: number): string =>
  servings === 1 ? "1 serving" : `${servings} servings`;

/* ------------------------------------------------------------------------------------------------
 * Picking recipes
 * ---------------------------------------------------------------------------------------------- */

/** The servings a recipe is usually made for (its yield). */
export const defaultServingsFor = (record: SavedRecipeRecord | undefined): number | undefined =>
  record ? parseServings(record.recipe.servings)?.min : undefined;

const COURSES: readonly RecipeCourse[] = [
  "breakfast",
  "lunch",
  "dinner",
  "dessert",
  "snack",
  "side",
  "drink",
  "baking"
];
const courseCache = new WeakMap<Recipe, RecipeCourse | null>();

/** The recipe's course: the cook's own tag wins ("Breakfast"), else the domain's inference. */
const recipeCourseFor = (record: SavedRecipeRecord): RecipeCourse | null => {
  const tags = new Set(getRecipeTags(record).map((tag) => tag.toLowerCase()));
  const tagged = COURSES.find((course) => tags.has(course));

  if (tagged) {
    return tagged;
  }

  const cached = courseCache.get(record.recipe);

  if (cached !== undefined) {
    return cached;
  }

  const course = inferRecipeTags(record.recipe).course?.value ?? null;
  courseCache.set(record.recipe, course);
  return course;
};

/** How well a course suits a meal: 2 made for it, 0 unknown or fine, negative a poor fit. */
const SLOT_FIT: Record<MealPlanSlot, Partial<Record<RecipeCourse, number>>> = {
  breakfast: { baking: 0, breakfast: 2, dessert: -1, dinner: -1, drink: 0, lunch: -1, side: -1 },
  dinner: { baking: -2, breakfast: -2, dessert: -2, dinner: 2, drink: -2, lunch: 1, snack: -1 },
  lunch: { baking: -1, breakfast: -1, dessert: -2, dinner: 1, drink: -1, lunch: 2 },
  snack: { baking: 1, breakfast: 0, dessert: 1, dinner: -1, lunch: -1, snack: 2 }
};

const slotFit = (record: SavedRecipeRecord, slot: MealPlanSlot): number => {
  const course = recipeCourseFor(record);
  return course ? (SLOT_FIT[slot][course] ?? 0) : 0;
};

/**
 * Picker order, as on the web: what suits the meal first (no cookies for breakfast, no pancakes
 * for dinner); within that, favorites, then often cooked, then everything else by title.
 */
export const rankRecipesForPlanning = (
  records: readonly SavedRecipeRecord[],
  slot?: MealPlanSlot
): SavedRecipeRecord[] =>
  records
    .map((record) => ({
      fit: slot ? Math.sign(slotFit(record, slot)) : 0,
      record,
      score: (record.favorite ? 1_000 : 0) + Math.min(record.timesCooked ?? 0, 50) * 8
    }))
    .sort(
      (a, b) =>
        b.fit - a.fit ||
        b.score - a.score ||
        a.record.recipe.title.localeCompare(b.record.recipe.title)
    )
    .map((entry) => entry.record);

/** The slot a new entry on a day most likely wants: dinner unless it is taken. */
export const suggestSlot = (dayEntries: readonly Pick<MealPlanEntry, "slot">[]): MealPlanSlot => {
  const taken = new Set(dayEntries.map((entry) => entry.slot));
  return (
    (["dinner", "lunch", "breakfast", "snack"] as const).find((slot) => !taken.has(slot)) ??
    "dinner"
  );
};

/* ------------------------------------------------------------------------------------------------
 * Shopping for the week
 * ---------------------------------------------------------------------------------------------- */

const roundUpCount = (value: number): number => Math.max(1, Math.ceil(value - 1e-9));

/** "1.5 eggs" → "2 eggs": a store sells whole ones. Measured amounts are left as they are. */
const roundUpCountForShopping = (item: AggregatedShoppingItem): AggregatedShoppingItem => {
  if (item.qty == null || (item.unit && getUnitDefinition(item.unit)?.kind !== "count")) {
    return item;
  }

  if (typeof item.qty === "number") {
    return Number.isInteger(item.qty) ? item : { ...item, qty: roundUpCount(item.qty) };
  }

  const min = roundUpCount(item.qty.min);
  const max = roundUpCount(item.qty.max);
  const qty: ShoppingQuantity = min === max ? min : { max, min };
  return { ...item, qty };
};

export interface PlanShopping {
  items: AggregatedShoppingItem[];
  /** Meals with a recipe still in the cookbook. */
  mealCount: number;
  recipeCount: number;
  /** Meals with no recipe ("Leftovers") or whose recipe was deleted. */
  skippedCount: number;
}

/** Every planned recipe's ingredients, scaled to each meal's servings and merged into one list. */
export const buildPlanShopping = (
  entries: readonly MealPlanEntry[],
  recipesById: ReadonlyMap<string, SavedRecipeRecord>,
  units: ShoppingUnitMode = "original"
): PlanShopping => {
  const recipes = new Map<string, Recipe>();

  for (const entry of entries) {
    const record = entry.recipeId ? recipesById.get(entry.recipeId) : undefined;

    if (record) {
      recipes.set(record.id, record.recipe);
    }
  }

  const withRecipes = entries.filter((entry) => entry.recipeId && recipes.has(entry.recipeId));

  return {
    items: mergeShoppingInputs(buildShoppingInputsForPlan(withRecipes, recipes, { units })).map(
      roundUpCountForShopping
    ),
    mealCount: withRecipes.length,
    recipeCount: recipes.size,
    skippedCount: entries.length - withRecipes.length
  };
};

/** A merged item as a line for the shopping list (credited to its first recipe). */
export const toShoppingListInput = (item: AggregatedShoppingItem): AddShoppingItemInput => ({
  text: formatShoppingItemText(item),
  ...(item.recipeIds[0] ? { recipeId: item.recipeIds[0] } : {}),
  ...(item.recipeTitles[0] ? { recipeTitle: item.recipeTitles[0] } : {})
});
