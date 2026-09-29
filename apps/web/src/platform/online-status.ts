import { useSyncExternalStore } from "react";

const readOnline = (): boolean => {
  try {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  } catch {
    return true;
  }
};

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);

  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};

/** `navigator.onLine`, kept current by the browser's online/offline events. */
export const useOnlineStatus = (): boolean =>
  useSyncExternalStore(subscribe, readOnline, () => true);
