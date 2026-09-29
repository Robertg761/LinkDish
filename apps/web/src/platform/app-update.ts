import { useSyncExternalStore } from "react";

import { addNetworkListeners } from "./detect-network";

/**
 * New versions of LinkDish install in the background (vite-plugin-pwa, registerType "prompt").
 * When one is waiting, the shell offers "Reload"; if that is ignored for a while, the update is
 * applied on the next in-app navigation instead (a full page load at the destination), so long
 * sessions don't drift onto an old build. Chunk-load recovery (platform/lazy.ts) still covers
 * tabs that outlive a deploy before the new worker is found.
 */

/** How long an ignored update prompt waits before applying itself on the next navigation. */
export const AUTO_APPLY_UPDATE_AFTER_MS = 2 * 60_000;

/** How often an open tab asks the server for a newer service worker. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;

/** How long a pending Undo keeps an ignored update from reloading the page on navigation. */
export const UNDO_UPDATE_HOLD_MS = 60_000;

/**
 * After registering the service worker fails (e.g. the connection dropped as the app loaded), it is
 * tried again after this long, twice as long each time, or as soon as the connection comes back;
 * {@link MAX_REGISTER_ATTEMPTS} tries in all, since some browsers (a private window) never allow it.
 */
export const REGISTER_RETRY_MS = 30_000;
export const MAX_REGISTER_ATTEMPTS = 5;

export interface AppUpdateSnapshot {
  /** A new version is installed and waiting to take over. */
  needRefresh: boolean;
  /** When `needRefresh` became true (ms since epoch). */
  readySince: number | null;
  /** `applyUpdate` was called; the page reloads once the new worker takes control. */
  applying: boolean;
}

type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>;

interface RegisterSWModule {
  registerSW: (options?: {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegisteredSW?: (
      swScriptUrl: string,
      registration: ServiceWorkerRegistration | undefined
    ) => void;
    onRegisterError?: (error: unknown) => void;
  }) => UpdateServiceWorker;
}

const initialSnapshot: AppUpdateSnapshot = {
  applying: false,
  needRefresh: false,
  readySince: null
};

let snapshot: AppUpdateSnapshot = initialSnapshot;
let updateServiceWorker: UpdateServiceWorker | null = null;
let registration: Promise<void> | null = null;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let registerAttempts = 0;
/** Cancels the retry waiting after a failed registration (timer and connection listener). */
let cancelRetry: (() => void) | null = null;
let autoApplyHeldUntil = 0;
const listeners = new Set<() => void>();

const setSnapshot = (patch: Partial<AppUpdateSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => {
    listener();
  });
};

export const getAppUpdateSnapshot = (): AppUpdateSnapshot => snapshot;

export const subscribeAppUpdate = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const useAppUpdate = (): AppUpdateSnapshot =>
  useSyncExternalStore(subscribeAppUpdate, getAppUpdateSnapshot, getAppUpdateSnapshot);

/** Marks a waiting update (called by the service worker registration). */
export const markUpdateReady = (now: number = Date.now()): void => {
  if (!snapshot.needRefresh) {
    setSnapshot({ needRefresh: true, readySince: now });
  }
};

/** Activates the waiting worker; the page reloads when it takes control. */
export const applyUpdate = async (): Promise<void> => {
  if (!updateServiceWorker || snapshot.applying) {
    return;
  }

  setSnapshot({ applying: true });

  try {
    await updateServiceWorker(true);
  } catch {
    setSnapshot({ applying: false });
  }
};

/** True once an ignored update should apply itself at the next navigation. */
export const shouldAutoApplyUpdate = (now: number = Date.now()): boolean =>
  snapshot.needRefresh &&
  !snapshot.applying &&
  snapshot.readySince !== null &&
  now - snapshot.readySince >= AUTO_APPLY_UPDATE_AFTER_MS &&
  now >= autoApplyHeldUntil;

/**
 * Keeps an ignored update from applying itself (a full reload) on navigation for `ms`: e.g. a
 * delete that moves to another page and offers Undo, whose snapshot lives only in memory. The
 * "Reload" prompt still works; the update just waits for a later navigation.
 */
export const holdAutoApplyUpdate = (ms: number, now: number = Date.now()): void => {
  autoApplyHeldUntil = Math.max(autoApplyHeldUntil, now + ms);
};

const loadRegisterSW = (): Promise<RegisterSWModule> =>
  import("virtual:pwa-register") as Promise<RegisterSWModule>;

/**
 * Registering failed: forget it, so the next try registers afresh, and try again after a while or
 * once the connection is back (see REGISTER_RETRY_MS). Only the latest registration's failure
 * counts.
 */
const retryRegistration = (
  failed: Promise<void> | null,
  load: () => Promise<RegisterSWModule>
): void => {
  if (registration !== failed) {
    return;
  }

  registration = null;

  if (cancelRetry || registerAttempts >= MAX_REGISTER_ATTEMPTS) {
    return;
  }

  const retry = () => {
    cancelRetry?.();
    void startAppUpdates(load);
  };
  const timer = setTimeout(retry, REGISTER_RETRY_MS * 2 ** (registerAttempts - 1));
  const removeListeners = addNetworkListeners({ onOnline: retry });
  cancelRetry = () => {
    clearTimeout(timer);
    removeListeners();
    cancelRetry = null;
  };
};

/**
 * Registers the service worker (once) and starts listening for updates. Safe to call from
 * anywhere; does nothing where service workers are unavailable. A registration that fails is
 * tried again by itself (see REGISTER_RETRY_MS).
 */
export const startAppUpdates = (
  load: () => Promise<RegisterSWModule> = loadRegisterSW
): Promise<void> => {
  if (registration) {
    return registration;
  }

  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    registration = Promise.resolve();
    return registration;
  }

  cancelRetry?.();
  registerAttempts += 1;
  let current: Promise<void> | null = null;
  current = registration = load()
    .then(({ registerSW }) => {
      updateServiceWorker = registerSW({
        onNeedRefresh: () => markUpdateReady(),
        onRegisterError: (error) => {
          console.warn("Service worker registration failed:", error);
          retryRegistration(current, load);
        },
        onRegisteredSW: (_url, worker) => {
          if (!worker || checkTimer) {
            return;
          }

          // Long-lived tabs (an installed app left open) look for new versions now and then.
          checkTimer = setInterval(() => {
            if (navigator.onLine !== false) {
              void worker.update().catch(() => undefined);
            }
          }, UPDATE_CHECK_INTERVAL_MS);
        }
      });
    })
    .catch((error: unknown) => {
      console.warn("Could not start the update checker:", error);
      retryRegistration(current, load);
    });

  return registration;
};

export const resetAppUpdateForTests = (): void => {
  snapshot = initialSnapshot;
  updateServiceWorker = null;
  registration = null;
  autoApplyHeldUntil = 0;
  registerAttempts = 0;
  cancelRetry?.();

  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  listeners.clear();
};
