import { useSyncExternalStore } from "react";

/*
 * Where the kitchen timer dock renders. Normally inline in the app shell; while cook mode is open
 * it moves into a slot inside the cook-mode dialog, so its Pause / +1 min / Dismiss buttons are
 * inside the dialog's focus trap and its "timer is done" announcement is not hidden behind
 * aria-modal.
 */

let host: HTMLElement | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => host;

/** Callback ref for the slot element (null when it unmounts). */
export const setTimerDockHost = (element: HTMLElement | null): void => {
  if (host === element) {
    return;
  }

  host = element;
  listeners.forEach((listener) => listener());
};

/** The element the dock should portal into, or null to render in place. */
export const useTimerDockHost = (): HTMLElement | null =>
  useSyncExternalStore(subscribe, getSnapshot, () => null);
