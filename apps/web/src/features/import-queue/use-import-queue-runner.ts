import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../auth/AuthProvider";
import { recoverStaleImports, useImportQueue } from "../../data/import-queue-store";
import { addNetworkListeners, isOnline } from "../../platform/detect-network";
import { getWebBillingTier } from "../billing/web-billing";

import type { QueuePauseReason } from "./import-queue-runner";

/** Only one tab works through the queue at a time. */
export const IMPORT_QUEUE_LOCK_NAME = "linkdish:import-queue";

export interface ImportQueueRunnerState {
  running: boolean;
  paused: QueuePauseReason | null;
  online: boolean;
  /** Clears a pause (e.g. after upgrading) and tries again. */
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
  const controllerRef = useRef<AbortController | null>(null);
  const tier = getWebBillingTier(user);
  const queuedKey = useMemo(
    () =>
      queue.items
        .filter((item) => item.status === "queued")
        .map((item) => `${item.id}:${item.updatedAt}`)
        .join("|"),
    [queue.items]
  );
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
      idleKeyRef.current === queuedKey
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
      }
    })
      .then((ran) => {
        if (!ran) {
          // Another tab is working through the queue; wait for the queue to change.
          idleKeyRef.current = queuedKey;
        }
      })
      .catch((error: unknown) => {
        // Storage trouble: don't spin; try again when the queue changes.
        idleKeyRef.current = queuedKey;
        console.warn("The import queue stopped.", error);
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
    queuedKey,
    running,
    tier
  ]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    []
  );

  const resume = useCallback(() => setPaused(null), []);

  return { online, paused, resume, running };
}
