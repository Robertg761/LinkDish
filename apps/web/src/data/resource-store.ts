import { useEffect, useSyncExternalStore } from "react";

import { subscribeDataChanges, type DataChange, type DataTopic } from "./change-feed";
import { isDeepEqual } from "./reconcile";

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

export interface OptimisticRecordOptions<T> {
  getId: (record: T) => string;
  /** Puts a new copy of the list back in order (it may sort that copy in place). */
  order: (records: T[]) => T[];
  /** Reads the record as stored now (`undefined`: there is none). */
  read: (id: string) => Promise<T | undefined>;
  /** Keeps the cached record's objects in an equal re-read one (default: the whole record). */
  reconcile?: ((cached: T, stored: T) => T) | undefined;
}

/**
 * Shows `change(record)` in the cache at once (`undefined` removes the record) while `commit`
 * saves it. Settles like `commit`.
 */
export type OptimisticRecordChange<T> = <Result>(
  id: string,
  change: (record: T) => T | undefined,
  commit: () => Promise<Result>
) => Promise<Result>;

const keepEqualRecord = <T>(cached: T, stored: T): T =>
  isDeepEqual(cached, stored) ? cached : stored;

/**
 * Optimistic changes to single records of a list resource. A failed save rolls back that one
 * record, never a snapshot of the whole list: that would undo every other change that landed
 * while the save was pending (a record deleted meanwhile would come back, a newer write would be
 * lost), and the stale view would stay until a reload.
 *
 * The rollback only happens while the cache still shows this change: a newer change to the record
 * (a later write's result, another tab's reload) is kept. It puts back the record as it was, then
 * settles on the record as storage has it now, since what it put back may itself have been
 * another optimistic change that failed too, or the record may have been deleted meanwhile.
 */
export function createOptimisticRecordChange<T>(
  store: ResourceStore<T[]>,
  { getId, order, read, reconcile = keepEqualRecord }: OptimisticRecordOptions<T>
): OptimisticRecordChange<T> {
  /**
   * Shows `next` for record `id` (`undefined`: none) if the cache shows `expected` for it. A
   * record put back goes in at `at` before ordering, so it keeps its place among equals.
   */
  const swap = (id: string, expected: T | undefined, next: T | undefined, at = -1): boolean => {
    let swapped = false;

    store.update((current) => {
      const index = current.findIndex((record) => getId(record) === id);
      const shown = index === -1 ? undefined : current[index];

      if (shown !== expected) {
        return current;
      }

      swapped = true;

      if (next === shown) {
        return current;
      }

      if (next === undefined) {
        return current.filter((_record, position) => position !== index);
      }

      const list = [...current];

      if (index === -1) {
        list.splice(at === -1 ? list.length : at, 0, next);
      } else {
        list[index] = next;
      }

      return order(list);
    });

    return swapped;
  };

  /** After a rollback to `restored`: shows the record as stored, unless it changed meanwhile. */
  const settle = async (id: string, restored: T): Promise<void> => {
    let stored: T | undefined;

    try {
      stored = await read(id);
    } catch {
      // Storage can't be read either: keep the record as it was before the change.
      return;
    }

    swap(id, restored, stored && reconcile(restored, stored));
  };

  return async (id, change, commit) => {
    const cached = store.getSnapshot().data;
    const at = cached.findIndex((record) => getId(record) === id);
    const previous = at === -1 ? undefined : cached[at];
    const optimistic = previous && change(previous);
    const shown = previous !== undefined && swap(id, previous, optimistic);

    try {
      return await commit();
    } catch (error) {
      if (shown && swap(id, optimistic, previous, at)) {
        void settle(id, previous);
      }

      throw error;
    }
  };
}
