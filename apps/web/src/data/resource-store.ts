import { useEffect, useSyncExternalStore } from "react";

import { subscribeDataChanges, type DataChange, type DataTopic } from "./change-feed";

/**
 * A tiny cache-once, reactive resource built for `useSyncExternalStore` (no dependencies).
 *
 * - `load()` reads once; later calls are free until something invalidates the cache.
 * - Writes in this tab arrive as {@link DataChange}s carrying the written records and are applied
 *   in memory (`applyLocalChange`), so views update without re-reading IndexedDB.
 * - Writes in other tabs arrive through the BroadcastChannel feed and trigger a background reload.
 */

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface ResourceSnapshot<T> {
  data: T;
  error: unknown;
  status: ResourceStatus;
}

export interface ResourceStoreOptions<T> {
  initial: T;
  load: () => Promise<T>;
  topic: DataTopic;
  /** Returns the next data for a same-tab change, or `null` to reload from storage instead. */
  applyLocalChange?: ((current: T, change: DataChange) => T | null) | undefined;
  /**
   * Other tabs' changes that name their records (`upsertedIds` / `deletedIds`): re-read just
   * those and return the next data. Rejecting falls back to a full reload.
   */
  applyRemoteChanges?: ((current: T, changes: readonly DataChange[]) => Promise<T>) | undefined;
  /** Merges a full reload into the data already shown (e.g. keep unchanged records' objects). */
  reconcile?: ((previous: T, next: T) => T) | undefined;
}

export interface ResourceStore<T> {
  getSnapshot: () => ResourceSnapshot<T>;
  subscribe: (listener: () => void) => () => void;
  /** Loads once. `force` re-reads even when the cache is ready. Never rejects. */
  load: (options?: { force?: boolean }) => Promise<void>;
  /** Replaces the cached data (optimistic updates). No-op before the first successful load. */
  update: (updater: (current: T) => T) => void;
  reset: () => void;
}

const REMOTE_RELOAD_DELAY_MS = 40;

export function createResourceStore<T>(options: ResourceStoreOptions<T>): ResourceStore<T> {
  let snapshot: ResourceSnapshot<T> = { data: options.initial, error: null, status: "idle" };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let generation = 0;
  let reloadAfterInflight = false;
  let remoteReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeFeed: (() => void) | null = null;
  /** Other tabs' changes waiting for the debounce, and whether any of them needs a full reload. */
  let pendingRemote: DataChange[] = [];
  let pendingRemoteFull = false;

  const set = (next: Partial<ResourceSnapshot<T>>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => {
      listener();
    });
  };

  /** Re-reads only what other tabs changed; any failure falls back to a full reload. */
  const refreshRemote = (changes: readonly DataChange[]): Promise<void> => {
    const apply = options.applyRemoteChanges;

    if (!apply || inflight || snapshot.status !== "ready") {
      return store.load({ force: true });
    }

    const current = ++generation;
    const run: Promise<void> = Promise.resolve()
      .then(() => apply(snapshot.data, changes))
      .then(
        (data) => {
          if (current === generation && data !== snapshot.data) {
            set({ data });
          }
        },
        () => {
          if (current === generation) {
            reloadAfterInflight = true;
          }
        }
      )
      .finally(() => {
        if (inflight === run) {
          inflight = null;
        }

        if (reloadAfterInflight && current === generation) {
          reloadAfterInflight = false;
          void store.load({ force: true });
        }
      });

    inflight = run;
    return run;
  };

  const scheduleRemoteReload = (change: DataChange) => {
    if (change.upsertedIds?.length || change.deletedIds?.length) {
      pendingRemote.push(change);
    } else {
      pendingRemoteFull = true;
    }

    if (remoteReloadTimer) {
      return;
    }

    remoteReloadTimer = setTimeout(() => {
      remoteReloadTimer = null;
      const changes = pendingRemote;
      const full = pendingRemoteFull;
      pendingRemote = [];
      pendingRemoteFull = false;
      void (full ? store.load({ force: true }) : refreshRemote(changes));
    }, REMOTE_RELOAD_DELAY_MS);
  };

  const handleChange = (change: DataChange, source: "local" | "remote") => {
    if (snapshot.status === "idle") {
      // Nothing cached yet; the first load will read fresh data.
      return;
    }

    if (inflight) {
      reloadAfterInflight = true;
      return;
    }

    if (source === "remote" || change.reload || snapshot.status !== "ready") {
      if (source === "remote") {
        scheduleRemoteReload(change);
      } else {
        void store.load({ force: true });
      }

      return;
    }

    const next = options.applyLocalChange?.(snapshot.data, change) ?? null;

    if (next === null) {
      void store.load({ force: true });
      return;
    }

    if (next !== snapshot.data) {
      set({ data: next });
    }
  };

  const ensureFeed = () => {
    unsubscribeFeed ??= subscribeDataChanges(options.topic, handleChange);
  };

  const store: ResourceStore<T> = {
    getSnapshot: () => snapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      ensureFeed();

      return () => {
        listeners.delete(listener);
      };
    },

    load: ({ force = false } = {}) => {
      ensureFeed();

      if (!force && snapshot.status === "ready") {
        return Promise.resolve();
      }

      if (inflight) {
        if (force) {
          reloadAfterInflight = true;
        }

        return inflight;
      }

      const current = ++generation;

      if (snapshot.status !== "ready") {
        set({ error: null, status: "loading" });
      }

      // Callbacks run asynchronously, so `inflight` is always assigned before they settle.
      const run: Promise<void> = Promise.resolve()
        .then(() => options.load())
        .then(
          (data) => {
            if (current === generation) {
              const next =
                options.reconcile && snapshot.status === "ready"
                  ? options.reconcile(snapshot.data, data)
                  : data;
              set({ data: next, error: null, status: "ready" });
            }
          },
          (error: unknown) => {
            if (current === generation) {
              // A failed background refresh keeps showing the data we already have.
              set(snapshot.status === "ready" ? { error } : { error, status: "error" });
            }
          }
        )
        .finally(() => {
          if (inflight === run) {
            inflight = null;
          }

          if (reloadAfterInflight && current === generation) {
            reloadAfterInflight = false;
            void store.load({ force: true });
          }
        });

      inflight = run;
      return run;
    },

    update: (updater) => {
      if (snapshot.status !== "ready") {
        return;
      }

      const next = updater(snapshot.data);

      if (next !== snapshot.data) {
        set({ data: next });
      }
    },

    reset: () => {
      generation += 1;
      inflight = null;
      reloadAfterInflight = false;

      if (remoteReloadTimer) {
        clearTimeout(remoteReloadTimer);
        remoteReloadTimer = null;
      }

      unsubscribeFeed?.();
      unsubscribeFeed = null;
      pendingRemote = [];
      pendingRemoteFull = false;
      snapshot = { data: options.initial, error: null, status: "idle" };
      listeners.forEach((listener) => {
        listener();
      });
    }
  };

  return store;
}

/** Subscribes a component to a resource and triggers its first load. */
export function useResource<T>(store: ResourceStore<T>): ResourceSnapshot<T> {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    void store.load();
  }, [store]);

  return snapshot;
}

/** Collapses `idle` into `loading` for UI consumption. */
export const toViewStatus = (status: ResourceStatus): "loading" | "ready" | "error" =>
  status === "idle" ? "loading" : status;

/** Upserts records by key into a list, keeping the list's identity when nothing changed. */
export function upsertById<T>(
  list: readonly T[],
  records: readonly T[] | undefined,
  deletedIds: readonly string[] | undefined,
  getId: (record: T) => string
): T[] {
  if (!records?.length && !deletedIds?.length) {
    return list as T[];
  }

  const byId = new Map(list.map((record) => [getId(record), record]));

  for (const id of deletedIds ?? []) {
    byId.delete(id);
  }

  for (const record of records ?? []) {
    byId.set(getId(record), record);
  }

  return Array.from(byId.values());
}
