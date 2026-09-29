import { createElement, lazy, useState, useSyncExternalStore } from "react";

import { safeGetItem, safeSetItem } from "./safe-storage";

import type { ComponentProps, ComponentType } from "react";

/**
 * Self-healing code splitting.
 *
 * After a deploy an open tab can ask for chunk files that no longer exist, and a flaky network
 * can drop a chunk request. `lazyWithRetry` retries the import a few times, and — unlike
 * `React.lazy`, which caches a failed import forever — lets an error boundary's "Try again"
 * re-import (see {@link retryFailedLazyImports}). `installChunkErrorRecovery` reloads the page
 * once when Vite's preload helper reports a missing chunk.
 */

export const CHUNK_RELOAD_STORAGE_KEY = "linkdish:web:chunk-reload-at:v1";
/** A second chunk failure within this window shows the error UI instead of reloading again. */
export const CHUNK_RELOAD_GUARD_MS = 60_000;

const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /importing a module script failed/iu,
  /unable to preload css/iu,
  /loading (?:css )?chunk [\w-]+ failed/iu,
  /chunkloaderror/iu
];

/** True for the errors browsers and Vite raise when a code-split chunk can't be loaded. */
export const isChunkLoadError = (error: unknown): boolean => {
  if (!error || (typeof error !== "object" && typeof error !== "string")) {
    return false;
  }

  const record = typeof error === "object" ? (error as { message?: unknown; name?: unknown }) : {};
  const name = typeof record.name === "string" ? record.name : "";
  const message =
    typeof error === "string" ? error : typeof record.message === "string" ? record.message : "";

  return name === "ChunkLoadError" || CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

/**
 * Reloads the page unless it already reloaded for a chunk error in the last minute (or storage is
 * blocked, which would make the guard useless). Returns true when a reload was started.
 */
export const reloadOnceForChunkError = (
  reload: () => void = () => {
    window.location.reload();
  },
  now: number = Date.now()
): boolean => {
  const lastReload = Number(safeGetItem(CHUNK_RELOAD_STORAGE_KEY, "session") ?? 0);

  if (Number.isFinite(lastReload) && now - lastReload < CHUNK_RELOAD_GUARD_MS) {
    return false;
  }

  if (!safeSetItem(CHUNK_RELOAD_STORAGE_KEY, String(now), "session")) {
    return false;
  }

  reload();
  return true;
};

let recoveryInstalled = false;

/** Handles Vite's `vite:preloadError` by reloading once. Call at boot. */
export const installChunkErrorRecovery = (reload?: () => void): void => {
  if (recoveryInstalled || typeof window === "undefined") {
    return;
  }

  recoveryInstalled = true;
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForChunkError(reload)) {
      // The page is reloading; don't let the failed import surface as an error meanwhile.
      event.preventDefault();
    }
  });
};

/* ------------------------------------------------------------------------------------------------
 * lazyWithRetry
 * ---------------------------------------------------------------------------------------------- */

let retryEpoch = 0;
const epochListeners = new Set<() => void>();

const subscribeRetryEpoch = (listener: () => void) => {
  epochListeners.add(listener);

  return () => {
    epochListeners.delete(listener);
  };
};

const getRetryEpoch = () => retryEpoch;

/** Makes every lazy component whose import failed try again on its next render. */
export const retryFailedLazyImports = (): void => {
  retryEpoch += 1;
  epochListeners.forEach((listener) => {
    listener();
  });
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface LazyWithRetryOptions {
  /** Extra attempts after the first failure (default 2). */
  retries?: number | undefined;
  /** Delay before the first retry; doubles each time (default 400 ms). */
  retryDelayMs?: number | undefined;
  /**
   * Render as soon as this chunk is in, without waiting for the companion load (see
   * {@link setLazyCompanionLoad}). For the landing page and what it shows at first paint.
   */
  standalone?: boolean | undefined;
}

let companionLoad: (() => Promise<unknown>) | null = null;

/**
 * Registers a load that lazy components (unless `standalone`) wait for alongside their own chunk:
 * main.tsx registers the extended icon set, so a page or sheet never paints with blank icons.
 * Both download in parallel, and a failed companion load never fails the component.
 */
export const setLazyCompanionLoad = (load: (() => Promise<unknown>) | null): void => {
  companionLoad = load;
};

export async function importWithRetry<Module>(
  factory: () => Promise<Module>,
  { retries = 2, retryDelayMs = 400 }: LazyWithRetryOptions = {}
): Promise<Module> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await factory();
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        await wait(retryDelayMs * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

/** Any component, as `React.lazy` itself accepts (props are recovered with ComponentProps). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponentType = ComponentType<any>;

export type LazyWithRetryComponent<Component extends AnyComponentType> = ComponentType<
  ComponentProps<Component>
> & {
  /** Starts loading the chunk ahead of the first render (e.g. on hover or idle). */
  preload: () => Promise<void>;
};

/**
 * `React.lazy` with retries and in-app recovery. Same factory shape as `lazy`:
 *
 *   const AccountPage = lazyWithRetry(() =>
 *     import("../features/account/AccountPage").then((m) => ({ default: m.AccountPage }))
 *   );
 */
export function lazyWithRetry<Component extends AnyComponentType>(
  factory: () => Promise<{ default: Component }>,
  options?: LazyWithRetryOptions
): LazyWithRetryComponent<Component> {
  type Props = ComponentProps<Component>;
  let failedAtEpoch: number | null = null;
  // Set once the module has loaded (by a render or by preload()).
  let loadedComponent: Component | null = null;

  const load = () =>
    Promise.all([
      importWithRetry(factory, options),
      options?.standalone || !companionLoad ? undefined : companionLoad().catch(() => undefined)
    ]).then(([module]) => {
      loadedComponent = module.default;
      return module;
    });

  const createLazy = () =>
    lazy(() =>
      load().catch((error: unknown) => {
        failedAtEpoch = retryEpoch;
        throw error;
      })
    );

  let LazyComponent = createLazy();

  const LazyWithRetry = (props: Props) => {
    const epoch = useSyncExternalStore(subscribeRetryEpoch, getRetryEpoch, getRetryEpoch);
    // Preloaded before this mount (e.g. the landing page, fetched alongside the entry): render it
    // straight away instead of suspending for a promise that has already settled. Decided once
    // per mount, so the component type never changes under a mounted page.
    const [preloaded] = useState(() => loadedComponent);

    if (preloaded) {
      return createElement(preloaded as ComponentType<Props>, props);
    }

    if (failedAtEpoch !== null && epoch > failedAtEpoch) {
      failedAtEpoch = null;
      LazyComponent = createLazy();
    }

    return createElement(LazyComponent as unknown as ComponentType<Props>, props);
  };

  return Object.assign(LazyWithRetry, {
    preload: () => load().then(() => undefined)
  });
}
