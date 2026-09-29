/**
 * The zod contract for meal plan entries. Kept apart from the planning helpers in meal-plan.ts so
 * screens that only arrange a week do not load the schema library.
 */
import { z } from "zod";

import {
  isValidIsoDate,
  MAX_MEAL_PLAN_NOTE_LENGTH,
  MAX_MEAL_PLAN_SERVINGS,
  MAX_RECIPE_TITLE_LENGTH,
  MEAL_SLOTS
} from "./limits.js";

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
