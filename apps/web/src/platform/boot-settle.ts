import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import type { FC } from "react";

/*
 * Boot work the first screen doesn't need (the service worker, the kitchen timer dock, the
 * import queue count, the rest of the icon set, the API contracts, the analytics contract, the
 * search engine) waits until the page's main content is on screen, the page and its first photos
 * have loaded and the browser is idle. On a slow phone it would otherwise download and run in the
 * middle of the first meaningful paint and push it back.
 *
 * main.tsx arms the gate before the first render. It opens once the route's page has rendered
 * and no page holds it (the Cookbook holds it until the recipes are read from storage), then
 * waits for the load event and the page's fetchpriority=high images (up to LOAD_WAIT_CAP_MS),
 * the next paint and an idle period. It opens after SETTLE_CAP_MS whatever happens. Unarmed
 * (unit tests), deferred work runs on the next task and everything counts as settled.
 */

type Task = () => void;

/** Opens the gate even if a page never releases it (storage that never answers, say). */
export const SETTLE_CAP_MS = 6000;
/** How long the settled content waits for the load event and its first photos. */
export const LOAD_WAIT_CAP_MS = 3000;
const IDLE_TIMEOUT_MS = 1500;

let armed = false;
let settled = false;
let opening = false;
let routeRendered = false;
let holds = 0;
let queue: Task[] = [];
const listeners = new Set<() => void>();

const runTask = (task: Task) => {
  try {
    task();
  } catch (error) {
    console.error("Deferred boot task failed:", error);
  }
};

const settle = () => {
  if (settled) {
    return;
  }

  settled = true;
  const tasks = queue;
  queue = [];
  tasks.forEach(runTask);
  listeners.forEach((listener) => listener());
};

const whenIdle = (callback: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(callback, 50);
  }
};

/**
 * Runs `callback` after the frame that shows the current content has been painted (the task
 * after the next animation frame). Returns a function that cancels it if it hasn't run yet.
 */
export const afterNextPaint = (callback: () => void): (() => void) => {
  let frame: number | null = null;
  let timer: number | null = null;

  if (typeof window.requestAnimationFrame === "function") {
    frame = window.requestAnimationFrame(() => {
      frame = null;
      timer = window.setTimeout(callback, 0);
    });
  } else {
    timer = window.setTimeout(callback, 0);
  }

  return () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
    }

    if (timer !== null) {
      window.clearTimeout(timer);
    }
  };
};

/** An image the page asked to fetch first (a recipe hero, the first cards) still loading. */
const isLoadingPriorityImage = (image: HTMLImageElement): boolean =>
  image.getAttribute("fetchpriority") === "high" && !image.complete;

/**
 * Once the page has loaded and so have the images it put first (added by script after the load
 * event, they don't hold it back themselves): a returning cook's first screen is their photos,
 * and deferred downloads would share the connection with them. Waits LOAD_WAIT_CAP_MS at most.
 */
const afterFirstScreenLoaded = (callback: () => void) => {
  let done = false;
  let pending = 0;
  const cleanups: Array<() => void> = [];
  const finish = () => {
    if (!done) {
      done = true;
      cleanups.forEach((cleanup) => cleanup());
      callback();
    }
  };
  const settleOne = () => {
    pending -= 1;

    if (pending === 0) {
      finish();
    }
  };
  const watch = (target: EventTarget, events: readonly string[]) => {
    pending += 1;
    let counted = false;
    const onDone = () => {
      if (!counted) {
        counted = true;
        settleOne();
      }
    };

    events.forEach((event) => target.addEventListener(event, onDone));
    cleanups.push(() => events.forEach((event) => target.removeEventListener(event, onDone)));
  };

  if (document.readyState !== "complete") {
    watch(window, ["load"]);
  }

  Array.from(document.images)
    .filter(isLoadingPriorityImage)
    .forEach((image) => {
      watch(image, ["load", "error"]);
    });

  if (pending === 0) {
    finish();
    return;
  }

  const timer = window.setTimeout(finish, LOAD_WAIT_CAP_MS);
  cleanups.push(() => window.clearTimeout(timer));
};

const maybeOpen = () => {
  if (!armed || settled || opening || !routeRendered || holds > 0) {
    return;
  }

  opening = true;
  afterFirstScreenLoaded(() => {
    afterNextPaint(() => {
      whenIdle(settle);
    });
  });
};

/** Starts holding deferred boot work back. Call once, before the first render. */
export const armBootSettle = (): void => {
  if (armed || typeof window === "undefined") {
    return;
  }

  armed = true;
  window.setTimeout(settle, SETTLE_CAP_MS);
};

/** True once deferred boot work may run (always, when the gate was never armed). */
export const isBootSettled = (): boolean => !armed || settled;

/**
 * Runs `task` once the first screen has settled (see the module comment). Returns a function
 * that cancels it if it hasn't run yet.
 */
export const whenBootSettled = (task: Task): (() => void) => {
  if (isBootSettled()) {
    const timer = setTimeout(() => runTask(task), 0);
    return () => clearTimeout(timer);
  }

  queue.push(task);
  return () => {
    queue = queue.filter((entry) => entry !== task);
  };
};

/** Holds the gate while a page's main content is still loading. Returns the release. */
export const holdBootSettle = (): (() => void) => {
  holds += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    holds -= 1;
    maybeOpen();
  };
};

/** The route's page (not its loading fallback) has rendered. */
export const markRouteRendered = (): void => {
  if (routeRendered) {
    return;
  }

  routeRendered = true;
  maybeOpen();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

/** Re-renders once deferred boot work may run. */
export const useBootSettled = (): boolean =>
  useSyncExternalStore(subscribe, isBootSettled, isBootSettled);

/**
 * Holds the gate while `loading`. A layout effect, so the hold is in place before the route
 * reports itself rendered (passive effects run after every layout effect of a commit).
 */
export const useBootSettleHold = (loading: boolean): void => {
  useLayoutEffect(() => (loading ? holdBootSettle() : undefined), [loading]);
};

/** Rendered inside the routes' Suspense boundary: reports when a page (not the fallback) shows. */
export const BootRouteRendered: FC = () => {
  useEffect(() => {
    markRouteRendered();
  }, []);

  return null;
};

export const resetBootSettleForTests = (): void => {
  armed = false;
  settled = false;
  opening = false;
  routeRendered = false;
  holds = 0;
  queue = [];
};
