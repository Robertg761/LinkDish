import { useCallback, useMemo } from "react";

import { updateStoredRecord } from "../storage/idb-update";
import { getLinkDishWebDb, MEAL_PLAN_STORE_NAME } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { getDateKeyRange, isDateKey } from "./date-keys";
import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

/**
 * The weekly meal plan: entries on a calendar day and slot, optionally pointing at a saved recipe
 * (the title is kept so the plan still reads well if the recipe is deleted). Local-only.
 */

export const MEAL_PLAN_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

export type MealPlanSlot = (typeof MEAL_PLAN_SLOTS)[number];

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

export interface MealPlanDay {
  date: string;
  entries: MealPlanEntry[];
}

const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;

export class MealPlanValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MealPlanValidationError";
  }
}

const isMealPlanSlot = (value: unknown): value is MealPlanSlot =>
  typeof value === "string" && (MEAL_PLAN_SLOTS as readonly string[]).includes(value);

const assertDate = (date: string): string => {
  if (!isDateKey(date)) {
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

const slotOrder = (slot: MealPlanSlot): number => MEAL_PLAN_SLOTS.indexOf(slot);

/** Day, then slot (breakfast → snack), then the order entries were added. */
export const compareMealPlanEntries = (a: MealPlanEntry, b: MealPlanEntry): number =>
  a.date.localeCompare(b.date) ||
  slotOrder(a.slot) - slotOrder(b.slot) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

export async function getMealPlanEntries(): Promise<MealPlanEntry[]> {
  const db = await getLinkDishWebDb();
  return ((await db.getAll(MEAL_PLAN_STORE_NAME)) as MealPlanEntry[]).sort(compareMealPlanEntries);
}

/** Entries on `days` consecutive days starting at `startDate`. */
export async function getMealPlanEntriesInRange(
  startDate: string,
  days: number
): Promise<MealPlanEntry[]> {
  const dates = new Set(getDateKeyRange(assertDate(startDate), days));
  return (await getMealPlanEntries()).filter((entry) => dates.has(entry.date));
}

const mealPlanResource = createResourceStore<MealPlanEntry[]>({
  applyLocalChange: (current, change) => {
    const next = upsertById(
      current,
      change.upserted as MealPlanEntry[] | undefined,
      change.deletedIds,
      (entry) => entry.id
    );
    return next === current ? current : [...next].sort(compareMealPlanEntries);
  },
  initial: [],
  load: getMealPlanEntries,
  topic: "mealPlan"
});

const writeEntry = async (entry: MealPlanEntry): Promise<MealPlanEntry> => {
  const db = await getLinkDishWebDb();
  await db.put(MEAL_PLAN_STORE_NAME, entry);
  emitDataChange({ topic: "mealPlan", upserted: [entry] });
  return entry;
};

export async function addMealPlanEntry(input: MealPlanEntryInput): Promise<MealPlanEntry> {
  const now = new Date().toISOString();
  const recipeId = input.recipeId?.trim();
  const servings = cleanServings(input.servings);
  const note = cleanNote(input.note);

  return writeEntry({
    createdAt: now,
    date: assertDate(input.date),
    id: crypto.randomUUID(),
    slot: assertSlot(input.slot),
    title: cleanTitle(input.title),
    updatedAt: now,
    ...(recipeId ? { recipeId } : {}),
    ...(servings ? { servings } : {}),
    ...(note ? { note } : {})
  });
}

/** Sets `key` to `value`, or removes it when `value` is empty. */
const setOrDelete = <Key extends "note" | "recipeId" | "servings">(
  entry: MealPlanEntry,
  key: Key,
  value: MealPlanEntry[Key] | undefined
): void => {
  if (value) {
    entry[key] = value;
  } else {
    delete entry[key];
  }
};

/**
 * Changes only the fields in `patch` (`null` clears an optional one). The entry is read and
 * written back in one readwrite transaction, so a change another tab (or handler) makes to the
 * same entry meanwhile is kept instead of overwritten, and a removed entry stays removed.
 */
export async function updateMealPlanEntry(
  id: string,
  patch: MealPlanEntryPatch
): Promise<MealPlanEntry | undefined> {
  // Validate first: the merge inside the transaction must not throw or wait.
  const changes: Partial<MealPlanEntry> = {
    ...(patch.date !== undefined ? { date: assertDate(patch.date) } : {}),
    ...(patch.slot !== undefined ? { slot: assertSlot(patch.slot) } : {}),
    ...(patch.title !== undefined ? { title: cleanTitle(patch.title) } : {})
  };
  const recipeId = patch.recipeId === undefined ? undefined : patch.recipeId?.trim() || "";
  const servings = patch.servings === undefined ? undefined : (cleanServings(patch.servings) ?? 0);
  const note = patch.note === undefined ? undefined : (cleanNote(patch.note) ?? "");
  const updatedAt = new Date().toISOString();

  const written = await updateStoredRecord<MealPlanEntry>(MEAL_PLAN_STORE_NAME, id, (existing) => {
    if (!existing) {
      return undefined;
    }

    const next: MealPlanEntry = { ...existing, ...changes, updatedAt };

    if (recipeId !== undefined) {
      setOrDelete(next, "recipeId", recipeId);
    }

    if (servings !== undefined) {
      setOrDelete(next, "servings", servings);
    }

    if (note !== undefined) {
      setOrDelete(next, "note", note);
    }

    return next;
  });

  if (written) {
    emitDataChange({ topic: "mealPlan", upserted: [written] });
  }

  return written;
}

/** Drag-and-drop helper: moves an entry to another day and/or slot. */
export const moveMealPlanEntry = (
  id: string,
  target: { date: string; slot?: MealPlanSlot | undefined }
): Promise<MealPlanEntry | undefined> =>
  updateMealPlanEntry(id, { date: target.date, ...(target.slot ? { slot: target.slot } : {}) });

export async function removeMealPlanEntry(id: string): Promise<void> {
  const db = await getLinkDishWebDb();
  await db.delete(MEAL_PLAN_STORE_NAME, id);
  emitDataChange({ deletedIds: [id], topic: "mealPlan" });
}

/** Optimistic variants for UIs: the cache updates first and rolls back if the write fails. */
export async function removeMealPlanEntryOptimistic(id: string): Promise<void> {
  const previous = mealPlanResource.getSnapshot().data;
  mealPlanResource.update((current) => current.filter((entry) => entry.id !== id));

  try {
    await removeMealPlanEntry(id);
  } catch (error) {
    mealPlanResource.update(() => previous);
    throw error;
  }
}

export async function moveMealPlanEntryOptimistic(
  id: string,
  target: { date: string; slot?: MealPlanSlot | undefined }
): Promise<MealPlanEntry | undefined> {
  const previous = mealPlanResource.getSnapshot().data;
  assertDate(target.date);
  mealPlanResource.update((current) =>
    current
      .map((entry) =>
        entry.id === id
          ? { ...entry, date: target.date, ...(target.slot ? { slot: target.slot } : {}) }
          : entry
      )
      .sort(compareMealPlanEntries)
  );

  try {
    return await moveMealPlanEntry(id, target);
  } catch (error) {
    mealPlanResource.update(() => previous);
    throw error;
  }
}

/** Groups entries into one bucket per day of the range (empty days included). */
export const groupMealPlanByDay = (
  entries: readonly MealPlanEntry[],
  startDate: string,
  days: number
): MealPlanDay[] => {
  const range = getDateKeyRange(startDate, days);
  const byDate = new Map<string, MealPlanEntry[]>(range.map((date) => [date, []]));

  for (const entry of entries) {
    byDate.get(entry.date)?.push(entry);
  }

  return range.map((date) => ({ date, entries: byDate.get(date) ?? [] }));
};

export interface MealPlanRangeView {
  days: MealPlanDay[];
  entries: MealPlanEntry[];
  error: unknown;
  retry: () => void;
  status: "loading" | "ready" | "error";
}

/** The plan for `days` consecutive days from `startDate` ("YYYY-MM-DD"). */
export function useMealPlanRange(startDate: string, days: number): MealPlanRangeView {
  const snapshot = useResource(mealPlanResource);
  const retry = useCallback(() => {
    void mealPlanResource.load({ force: true });
  }, []);
  const validStart = isDateKey(startDate);

  const grouped = useMemo(() => {
    if (!validStart) {
      return { days: [] as MealPlanDay[], entries: [] as MealPlanEntry[] };
    }

    const dayBuckets = groupMealPlanByDay(snapshot.data, startDate, days);
    return { days: dayBuckets, entries: dayBuckets.flatMap((day) => day.entries) };
  }, [days, snapshot.data, startDate, validStart]);

  return useMemo(
    () => ({
      ...grouped,
      error: snapshot.error,
      retry,
      status: toViewStatus(snapshot.status)
    }),
    [grouped, retry, snapshot.error, snapshot.status]
  );
}

export const loadMealPlan = (options?: { force?: boolean }): Promise<void> =>
  mealPlanResource.load(options);

export const getMealPlanSnapshot = () => mealPlanResource.getSnapshot();

/** Short aliases (`import * as mealPlan from ".../meal-plan-store"` → `mealPlan.addEntry(...)`). */
export {
  addMealPlanEntry as addEntry,
  moveMealPlanEntry as moveEntry,
  removeMealPlanEntry as removeEntry,
  updateMealPlanEntry as updateEntry
};

export function resetMealPlanStoreForTests(): void {
  mealPlanResource.reset();
}
