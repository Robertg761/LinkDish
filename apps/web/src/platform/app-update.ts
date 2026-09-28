import { useSyncExternalStore } from "react";

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
  now - snapshot.readySince >= AUTO_APPLY_UPDATE_AFTER_MS;

const loadRegisterSW = (): Promise<RegisterSWModule> =>
  import("virtual:pwa-register") as Promise<RegisterSWModule>;

/**
 * Registers the service worker (once) and starts listening for updates. Safe to call from
 * anywhere; does nothing where service workers are unavailable.
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

  registration = load()
    .then(({ registerSW }) => {
      updateServiceWorker = registerSW({
        onNeedRefresh: () => markUpdateReady(),
        onRegisterError: (error) => {
          console.warn("Service worker registration failed:", error);
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
    });

  return registration;
};

export const resetAppUpdateForTests = (): void => {
  snapshot = initialSnapshot;
  updateServiceWorker = null;
  registration = null;

  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  listeners.clear();
};
