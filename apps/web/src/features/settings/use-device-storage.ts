import { useCallback, useEffect, useState } from "react";

import { subscribeDataChanges } from "../../data/change-feed";
import { readPersistence, readStorageEstimate } from "../data-transfer/device-storage";
import { readLocalDataCounts } from "../data-transfer/local-data";

import type { PersistenceState, StorageEstimateInfo } from "../data-transfer/device-storage";
import type { LocalDataCounts } from "../data-transfer/local-data";

/** Recipe, collection and meal-plan counts on this device, kept fresh by data-change events. */
export function useLocalDataCounts(): LocalDataCounts | null {
  const [counts, setCounts] = useState<LocalDataCounts | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = () => {
      readLocalDataCounts().then(
        (next) => {
          if (!cancelled) {
            setCounts(next);
          }
        },
        () => {
          // Storage problems are shown by the status row; counts just stay as they were.
        }
      );
    };

    // Imports emit several topics at once; one re-read covers them all.
    const scheduleLoad = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 120);
    };

    load();
    const unsubscribers = (["savedRecipes", "collections", "mealPlan"] as const).map((topic) =>
      subscribeDataChanges(topic, scheduleLoad)
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  return counts;
}

export interface DeviceStorageState {
  estimate: StorageEstimateInfo | null;
  persistence: PersistenceState | null;
  refresh: () => void;
}

/** The browser's storage estimate and persistence flag (re-read after writes and on demand). */
export function useDeviceStorage(): DeviceStorageState {
  const [estimate, setEstimate] = useState<StorageEstimateInfo | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([readStorageEstimate(), readPersistence()]).then(
      ([nextEstimate, nextPersistence]) => {
        if (!cancelled) {
          setEstimate(nextEstimate);
          setPersistence(nextPersistence);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let timer: number | undefined;
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 400);
    };
    const unsubscribe = subscribeDataChanges("savedRecipes", scheduleRefresh);

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  return { estimate, persistence, refresh };
}
