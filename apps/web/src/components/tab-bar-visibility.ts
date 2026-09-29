import { useLayoutEffect, useSyncExternalStore } from "react";

/*
 * Pages can ask the app shell to drop the phone tab bar while they show their own floating
 * action bar (an import result, like the recipe page), so two bottom bars never stack. Route
 * metadata covers whole routes (app-route-meta `hideTabBar`); this covers a state inside one.
 */

let requests = 0;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => requests > 0;

/**
 * Hides the phone tab bar while the calling component is mounted and `hidden` is true. Applied
 * before paint, so the bar never flashes in underneath the page's own actions.
 */
export const useHideTabBar = (hidden = true): void => {
  useLayoutEffect(() => {
    if (!hidden) {
      return;
    }

    requests += 1;
    emit();

    return () => {
      requests = Math.max(0, requests - 1);
      emit();
    };
  }, [hidden]);
};

/** True while any mounted page asks for the tab bar to be hidden (read by AppShell). */
export const usePageHidesTabBar = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, () => false);
