import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../auth/AuthProvider";
import {
  getImportQueueSnapshot,
  recoverStaleImports,
  useImportQueue
} from "../../data/import-queue-store";
import { addNetworkListeners, isOnline } from "../../platform/detect-network";
import { getWebBillingTier } from "../billing/web-billing";

import type { QueuePauseReason } from "./import-queue-runner";
import type { ImportQueueItem } from "../../data/import-queue-store";

/** Only one tab works through the queue at a time. */
export const IMPORT_QUEUE_LOCK_NAME = "linkdish:import-queue";

/**
 * After storage trouble stops a run, the queue waits this long before trying again by itself,
 * twice as long after each run in a row that fails, up to {@link MAX_STORAGE_RETRY_MS}.
 */
export const STORAGE_RETRY_MS = 30 * 1000;
export const MAX_STORAGE_RETRY_MS = 5 * 60 * 1000;

/** The waiting items, as they are now: changes whenever one is added, retried or let go of. */
const queuedKeyOf = (items: readonly ImportQueueItem[]): string =>
  items
    .filter((item) => item.status === "queued")
    .map((item) => `${item.id}:${item.updatedAt}`)
    .join("|");

/**
 * Which items are waiting or importing, not how: a tab claiming an item and letting it go again
 * (as every tab does when storage can't be read) leaves this as it was.
 */
const pendingIdsOf = (items: readonly ImportQueueItem[]): string =>
  items
    .filter((item) => item.status === "queued" || item.status === "processing")
    .map((item) => item.id)
    .join("|");

/** Storage trouble stopped the last `failures` runs in a row; `waitingOn` is set until a retry. */
interface StorageStall {
  failures: number;
  /** The pending items (see pendingIdsOf) when the last run stopped; null once it may try again. */
  waitingOn: string | null;
}

export interface ImportQueueRunnerState {
  running: boolean;
  paused: QueuePauseReason | null;
  online: boolean;
  /** Storage trouble stopped the queue. It tries again by itself after a while, or on `resume`. */
  stalled: boolean;
  /** Clears a pause (e.g. after upgrading) or a stall, and tries again. */
  resume: () => void;
}

/**
 * Runs the task holding the queue lock; false when another tab already has it. Without Web Locks
 * every open import page runs the task: each item is claimed atomically for one tab (see
 * claimNextQueuedImport), so they share the queue without importing anything twice.
 */
const withQueueLock = async (task: () => Promise<void>): Promise<boolean> => {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;

  if (!locks?.request) {
    await task();
    return true;
  }

  let ran = false;
  await locks.request(IMPORT_QUEUE_LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (lock) {
      ran = true;
      await task();
    }
  });
  return ran;
};

/**
 * Processes queued imports one at a time while this screen is open and the browser is online.
 * Stale "processing" items (a tab closed mid-import, so its claim lapsed) go back in the queue on
 * mount.
 */
export function useImportQueueRunner(enabled = true): ImportQueueRunnerState {
  // Imports run only once requests carry the account (not while a cached Clerk user's session is
  // still loading), so they are neither billed as anonymous nor paused for the wrong limit.
  const { credentialsReady, isAuthenticated, user } = useAuth();
  const queue = useImportQueue();
  const [online, setOnline] = useState(isOnline);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState<QueuePauseReason | null>(null);
  const [stall, setStall] = useState<StorageStall | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const tier = getWebBillingTier(user);
  const queuedKey = useMemo(() => queuedKeyOf(queue.items), [queue.items]);
  const pendingIds = useMemo(() => pendingIdsOf(queue.items), [queue.items]);
  const hasQueued = queuedKey.length > 0;
  /** The queue as it was when a run found nothing to do; don't spin on it again. */
  const idleKeyRef = useRef<string | null>(null);

  useEffect(() => {
    void recoverStaleImports().catch(() => 0);
  }, []);

  useEffect(
    () =>
      addNetworkListeners({
        onOffline: () => setOnline(false),
        onOnline: () => {
          setOnline(true);
          setPaused((current) => (current === "offline" ? null : current));
        }
      }),
    []
  );

  // A new plan (or signing in) may lift a limit pause.
  useEffect(() => {
    setPaused((current) => (current === "offline" ? current : null));
  }, [isAuthenticated, tier]);

  useEffect(() => {
    if (
      !enabled ||
      !credentialsReady ||
      !online ||
      running ||
      paused ||
      !hasQueued ||
      idleKeyRef.current === queuedKey ||
      stall?.waitingOn === pendingIds
    ) {
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);

    void withQueueLock(async () => {
      // The worker (API client, save rules) loads only when there is something to import.
      const { runImportQueue } = await import("./import-queue-runner");
      const result = await runImportQueue({
        isAuthenticated,
        signal: controller.signal,
        tier
      });
      idleKeyRef.current = result.processed === 0 && !result.paused ? queuedKey : null;

      if (!controller.signal.aborted) {
        setPaused(result.paused);
        setStall(null);
      }
    })
      .then((ran) => {
        if (!ran) {
          // Another tab is working through the queue; wait for the queue to change.
          idleKeyRef.current = queuedKey;
        }
      })
      .catch((error: unknown) => {
        // Storage trouble: don't spin. Try again after a while, or sooner when something new is
        // waiting; not when a tab (this one or another) only lets the same item go again.
        idleKeyRef.current = null;
        console.warn("The import queue stopped.", error);

        if (!controller.signal.aborted) {
          const waitingOn = pendingIdsOf(getImportQueueSnapshot().data);
          setStall((current) => ({ failures: (current?.failures ?? 0) + 1, waitingOn }));
        }
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }

        if (!controller.signal.aborted) {
          setRunning(false);
        }
      });
  }, [
    credentialsReady,
    enabled,
    hasQueued,
    isAuthenticated,
    online,
    paused,
    pendingIds,
    queuedKey,
    running,
    stall,
    tier
  ]);

  // After storage trouble, try again by itself (the trouble may have passed), backing off.
  useEffect(() => {
    if (!stall || stall.waitingOn === null) {
      return;
    }

    const delay = Math.min(STORAGE_RETRY_MS * 2 ** (stall.failures - 1), MAX_STORAGE_RETRY_MS);
    const timer = setTimeout(() => {
      setStall((current) => (current ? { ...current, waitingOn: null } : current));
    }, delay);
    return () => clearTimeout(timer);
  }, [stall]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    []
  );

  const resume = useCallback(() => {
    idleKeyRef.current = null;
    setPaused(null);
    setStall((current) => (current ? { ...current, waitingOn: null } : current));
  }, []);

  return { online, paused, resume, running, stalled: stall !== null };
}
