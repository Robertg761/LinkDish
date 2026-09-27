/**
 * Meal planning: plan entries, calendar-date helpers and turning a week's plan into a shopping
 * list. Dates are ISO calendar dates ("2026-09-27") with no time zone, so a plan means the same
 * days on every device; date arithmetic runs in UTC to stay clear of daylight-saving shifts.
 */
import { z } from "zod";

import { MAX_RECIPE_TITLE_LENGTH } from "./recipe-schema.js";
import { scaleFactorForServings } from "./servings.js";
import { recipeIngredientsToShoppingInputs } from "./shopping-aggregate.js";

import type { IngredientUnitsPreference } from "./conversion.js";
import type { Recipe } from "./recipe-schema.js";
import type { ShoppingInput } from "./shopping-aggregate.js";

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const MAX_MEAL_PLAN_NOTE_LENGTH = 2_000;
export const MAX_MEAL_PLAN_SERVINGS = 1_000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

const isValidIsoDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

export const isoDateSchema = z.string().refine(isValidIsoDate, "Expected a YYYY-MM-DD date.");
export const mealSlotSchema = z.enum(MEAL_SLOTS);

/**
 * One planned meal: a saved recipe (by id) or a free-text entry ("Leftovers"). Follows the
 * household sync convention (id + ISO updatedAt, last write wins) so it can sync later.
 */
export const mealPlanEntrySchema = z.object({
  id: z.string().trim().min(1).max(120),
  date: isoDateSchema,
  slot: mealSlotSchema.nullable().optional(),
  recipeId: z.string().trim().min(1).max(180).nullable().optional(),
  title: z.string().trim().min(1).max(MAX_RECIPE_TITLE_LENGTH).nullable().optional(),
  servings: z.number().positive().max(MAX_MEAL_PLAN_SERVINGS).nullable().optional(),
  note: z.string().max(MAX_MEAL_PLAN_NOTE_LENGTH).nullable().optional(),
  updatedAt: z.string().datetime().optional()
});

export type MealSlot = z.infer<typeof mealSlotSchema>;
export type MealPlanEntry = z.infer<typeof mealPlanEntrySchema>;
export type WeekStartsOn = 0 | 1;

const pad = (value: number, length = 2): string => String(value).padStart(length, "0");

const formatUtcDate = (date: Date): string =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const toUtcDate = (isoDate: string): Date => {
  const match = ISO_DATE_PATTERN.exec(isoDate);
  return new Date(Date.UTC(Number(match?.[1]), Number(match?.[2]) - 1, Number(match?.[3])));
};

/**
 * The calendar date of a Date (in the device's local time), a timestamp, or an ISO string.
 * "2026-09-27" passes through; a full ISO timestamp is read as a local date. Throws on
 * invalid input.
 */
export const toIsoDate = (value: Date | string | number): string => {
  if (typeof value === "string" && isValidIsoDate(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(value)}`);
  }

  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** An ISO date moved by a number of days ("2026-09-27" + 7 → "2026-10-04"). */
export const addDaysToIsoDate = (date: Date | string, days: number): string => {
  const utc = toUtcDate(toIsoDate(date));
  utc.setUTCDate(utc.getUTCDate() + Math.trunc(days));
  return formatUtcDate(utc);
};

/** Day of the week for an ISO date: 0 = Sunday … 6 = Saturday. */
export const isoDayOfWeek = (date: Date | string): number => toUtcDate(toIsoDate(date)).getUTCDay();

/** First day of the week containing `date`: Sunday (0, default) or Monday (1). */
export const startOfWeek = (date: Date | string, weekStartsOn: WeekStartsOn = 0): string => {
  const isoDate = toIsoDate(date);
  const offset = (isoDayOfWeek(isoDate) - weekStartsOn + 7) % 7;
  return addDaysToIsoDate(isoDate, -offset);
};

/** The seven ISO dates of the week starting at `start`. */
export const weekDays = (start: Date | string): string[] => {
  const first = toIsoDate(start);
  return Array.from({ length: 7 }, (_unused, index) => addDaysToIsoDate(first, index));
};

const slotRank = (slot: MealSlot | null | undefined): number =>
  slot == null ? MEAL_SLOTS.length : MEAL_SLOTS.indexOf(slot);

/**
 * Entries grouped by date, each day's entries ordered breakfast → lunch → dinner → snack →
 * unslotted (ties keep input order). With `days`, every listed day is returned (empty days
 * included) and entries on other days are left out; otherwise the days that have entries are
 * returned in date order.
 */
export const groupEntriesByDay = <T extends { date: string; slot?: MealSlot | null | undefined }>(
  entries: readonly T[],
  days?: readonly string[]
): Array<{ date: string; entries: T[] }> => {
  const byDay = new Map<string, Array<{ entry: T; index: number }>>();

  entries.forEach((entry, index) => {
    const bucket = byDay.get(entry.date);

    if (bucket) {
      bucket.push({ entry, index });
    } else {
      byDay.set(entry.date, [{ entry, index }]);
    }
  });

  const dates = days ? [...days] : [...byDay.keys()].sort();

  return dates.map((date) => ({
    date,
    entries: (byDay.get(date) ?? [])
      .sort(
        (left, right) =>
          slotRank(left.entry.slot) - slotRank(right.entry.slot) || left.index - right.index
      )
      .map(({ entry }) => entry)
  }));
};

export type PlanShoppingOptions = {
  units?: IngredientUnitsPreference | undefined;
  /** Only entries on these dates (for "shop for this week"). */
  dates?: readonly string[] | undefined;
};

type PlannedRecipe = Pick<Recipe, "title" | "ingredients" | "servings">;
type RecipeLookup =
  | ReadonlyMap<string, PlannedRecipe>
  | Readonly<Record<string, PlannedRecipe | undefined>>;

const isRecipeMap = (lookup: RecipeLookup): lookup is ReadonlyMap<string, PlannedRecipe> =>
  lookup instanceof Map;

const lookupRecipe = (recipesById: RecipeLookup, id: string): PlannedRecipe | undefined =>
  isRecipeMap(recipesById) ? recipesById.get(id) : recipesById[id];

/**
 * Shopping inputs for planned meals: each entry's recipe ingredients, scaled from the recipe's
 * servings to the entry's servings (unscaled when either is unknown), in the chosen units and
 * attributed to the recipe. Entries without a known recipe are skipped. Feed the result to
 * `mergeShoppingInputs` for one combined list.
 */
export const buildShoppingInputsForPlan = (
  entries: ReadonlyArray<Pick<MealPlanEntry, "date" | "recipeId" | "servings">>,
  recipesById: RecipeLookup,
  options: PlanShoppingOptions = {}
): ShoppingInput[] => {
  const dateFilter = options.dates ? new Set(options.dates) : null;

  return entries.flatMap((entry) => {
    if (!entry.recipeId || (dateFilter && !dateFilter.has(entry.date))) {
      return [];
    }

    const recipe = lookupRecipe(recipesById, entry.recipeId);

    if (!recipe) {
      return [];
    }

    const scale = entry.servings ? scaleFactorForServings(recipe.servings, entry.servings) : 1;

    return recipeIngredientsToShoppingInputs(recipe, {
      recipeId: entry.recipeId,
      scale,
      units: options.units ?? "original"
    });
  });
};
