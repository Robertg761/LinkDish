import { useSyncExternalStore } from "react";

import { safeGetItem, safeSetItem } from "./safe-storage";

/**
 * A one-way "this has happened" flag in localStorage (a first save, a dismissed tip) that mounted
 * components can follow. Reading the key once in a `useState` initializer misses a write made
 * elsewhere while the component stays on screen; this store tells its subscribers about writes
 * made through it in this tab and, through the `storage` event, about writes in other tabs.
 */
export interface StorageFlag {
  /** True once set, in this tab or another. */
  read: () => boolean;
  /** Sets the flag and tells subscribers. It holds for this page load even when storage refuses it. */
  set: () => void;
  subscribe: (listener: () => void) => () => void;
  /** Test seam: forgets a flag that was only kept in memory. */
  resetForTests: () => void;
}

export const createStorageFlag = (key: string): StorageFlag => {
  const listeners = new Set<() => void>();
  // Private mode and blocked storage refuse the write; the flag still applies until reload.
  let setInMemory = false;

  const read = (): boolean => setInMemory || safeGetItem(key) === "true";

  const emit = (): void => {
    listeners.forEach((listener) => {
      listener();
    });
  };

  const onStorage = (event: StorageEvent): void => {
    // A null key means another tab cleared storage altogether.
    if (event.key === null || event.key === key) {
      emit();
    }
  };

  return {
    read,
    resetForTests: () => {
      setInMemory = false;
    },
    set: () => {
      if (read()) {
        return;
      }

      if (!safeSetItem(key, "true")) {
        setInMemory = true;
      }

      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      if (listeners.size === 1) {
        window.addEventListener("storage", onStorage);
      }

      return () => {
        listeners.delete(listener);

        if (listeners.size === 0) {
          window.removeEventListener("storage", onStorage);
        }
      };
    }
  };
};

/** The flag's current value, re-rendering when it is set here or in another tab. */
export const useStorageFlag = (flag: StorageFlag): boolean =>
  useSyncExternalStore(flag.subscribe, flag.read, flag.read);
