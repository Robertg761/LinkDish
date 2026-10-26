import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AppState } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { createDebouncedWriter } from "../../lib/debouncedWriter";

import {
  compareMealPlanEntries,
  createMealPlanEntry,
  MEAL_PLAN_STORAGE_KEY,
  parseMealPlan,
  updateMealPlanEntryRecord,
  type MealPlanEntry,
  type MealPlanEntryInput,
  type MealPlanEntryPatch
} from "./store";

import type { WeekStartsOn } from "@linkdish/recipe-domain";

export const WEEK_STARTS_ON_STORAGE_KEY = "linkdish.mealPlan.weekStartsOn.v1";
const MEAL_PLAN_PERSIST_DEBOUNCE_MS = 400;

interface MealPlanContextValue {
  entries: MealPlanEntry[];
  hasLoadedMealPlan: boolean;
  /** Throws MealPlanValidationError on a bad day, slot or title. */
  addEntry: (input: MealPlanEntryInput, source: MealPlanEntrySource) => MealPlanEntry;
  /** Throws MealPlanValidationError on a bad day, slot or title. */
  updateEntry: (id: string, patch: MealPlanEntryPatch) => void;
  removeEntry: (id: string) => void;
  /** Adds entries this device doesn't have yet (by id), e.g. from a backup. Returns how many. */
  importEntries: (entries: readonly MealPlanEntry[]) => Promise<number>;
  weekStartsOn: WeekStartsOn;
  setWeekStartsOn: (value: WeekStartsOn) => void;
}

/** Where a meal was planned from, for the meal_plan_entry_added event. */
export type MealPlanEntrySource = "plan" | "recipe_page";

const MealPlanContext = createContext<MealPlanContextValue | null>(null);

const sortEntries = (entries: MealPlanEntry[]): MealPlanEntry[] =>
  [...entries].sort(compareMealPlanEntries);

/** The meal plan on this device, kept in AsyncStorage like the cookbook. */
export const MealPlanProvider = ({ children }: { children: ReactNode }) => {
  const [entries, setEntries] = useState<MealPlanEntry[]>([]);
  const [hasLoadedMealPlan, setHasLoadedMealPlan] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [weekStartsOn, setWeekStartsOnState] = useState<WeekStartsOn>(0);
  const entriesRef = useRef(entries);

  const writer = useMemo(
    () =>
      createDebouncedWriter<MealPlanEntry[]>(
        (value) => AsyncStorage.setItem(MEAL_PLAN_STORAGE_KEY, JSON.stringify(value)),
        MEAL_PLAN_PERSIST_DEBOUNCE_MS,
        (error) => {
          console.warn("Failed to persist the meal plan.", error);
        }
      ),
    []
  );

  const commit = useCallback((update: (current: MealPlanEntry[]) => MealPlanEntry[]) => {
    const next = update(entriesRef.current);

    if (next !== entriesRef.current) {
      entriesRef.current = next;
      setEntries(next);
    }

    return next;
  }, []);

  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(MEAL_PLAN_STORAGE_KEY)
      .then((stored) => {
        if (isMounted) {
          // Anything planned before this read landed is kept.
          commit((current) => {
            const known = new Set(current.map((entry) => entry.id));
            return sortEntries([
              ...current,
              ...parseMealPlan(stored ?? null).filter((entry) => !known.has(entry.id))
            ]);
          });
        }
      })
      .catch((error: unknown) => {
        console.warn("Failed to load the meal plan.", error);

        if (isMounted) {
          setReadFailed(true);
        }
      })
      .finally(() => {
        if (isMounted) {
          setHasLoadedMealPlan(true);
        }
      });

    AsyncStorage.getItem(WEEK_STARTS_ON_STORAGE_KEY)
      .then((stored) => {
        if (isMounted && (stored === "0" || stored === "1")) {
          setWeekStartsOnState(stored === "1" ? 1 : 0);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [commit]);

  // A plan that could not be read is never written over.
  useEffect(() => {
    if (hasLoadedMealPlan && !readFailed) {
      writer.schedule(entries);
    }
  }, [entries, hasLoadedMealPlan, readFailed, writer]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        void writer.flush().catch((error: unknown) => {
          console.warn("Failed to persist the meal plan.", error);
        });
      }
    });

    return () => {
      subscription.remove();
      void writer.flush().catch(() => undefined);
    };
  }, [writer]);

  const addEntry = useCallback(
    (input: MealPlanEntryInput, source: MealPlanEntrySource) => {
      const entry = createMealPlanEntry(input);
      commit((current) => sortEntries([...current, entry]));
      trackMobileEvent({
        eventName: "meal_plan_entry_added",
        properties: { kind: entry.recipeId ? "recipe" : "note", slot: entry.slot, source },
        routeOrScreen: source === "plan" ? "plan" : "recipe"
      });
      return entry;
    },
    [commit]
  );

  const updateEntry = useCallback(
    (id: string, patch: MealPlanEntryPatch) => {
      const existing = entriesRef.current.find((entry) => entry.id === id);

      if (!existing) {
        return;
      }

      const updated = updateMealPlanEntryRecord(existing, patch);
      commit((current) => sortEntries(current.map((entry) => (entry.id === id ? updated : entry))));
    },
    [commit]
  );

  const removeEntry = useCallback(
    (id: string) => {
      commit((current) =>
        current.some((entry) => entry.id === id)
          ? current.filter((entry) => entry.id !== id)
          : current
      );
    },
    [commit]
  );

  const importEntries = useCallback(
    async (incoming: readonly MealPlanEntry[]) => {
      const known = new Set(entriesRef.current.map((entry) => entry.id));
      const fresh = incoming.filter((entry) => !known.has(entry.id));

      if (fresh.length === 0) {
        return 0;
      }

      const next = commit((current) => sortEntries([...current, ...fresh]));

      if (!readFailed) {
        await writer.writeNow(next);
      }

      return fresh.length;
    },
    [commit, readFailed, writer]
  );

  const setWeekStartsOn = useCallback((value: WeekStartsOn) => {
    setWeekStartsOnState(value);
    void AsyncStorage.setItem(WEEK_STARTS_ON_STORAGE_KEY, String(value)).catch(() => undefined);
  }, []);

  const value = useMemo<MealPlanContextValue>(
    () => ({
      addEntry,
      entries,
      hasLoadedMealPlan,
      importEntries,
      removeEntry,
      setWeekStartsOn,
      updateEntry,
      weekStartsOn
    }),
    [
      addEntry,
      entries,
      hasLoadedMealPlan,
      importEntries,
      removeEntry,
      setWeekStartsOn,
      updateEntry,
      weekStartsOn
    ]
  );

  return <MealPlanContext.Provider value={value}>{children}</MealPlanContext.Provider>;
};

export const useMealPlan = (): MealPlanContextValue => {
  const context = useContext(MealPlanContext);

  if (!context) {
    throw new Error("useMealPlan must be used inside MealPlanProvider.");
  }

  return context;
};
