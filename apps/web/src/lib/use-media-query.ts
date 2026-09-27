import { useCallback, useSyncExternalStore } from "react";

const getMediaQueryList = (query: string): MediaQueryList | null => {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
};

/** Subscribes to a CSS media query, e.g. useMediaQuery("(min-width: 1024px)"). */
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = getMediaQueryList(query);

      if (!list) {
        return () => undefined;
      }

      if (typeof list.addEventListener === "function") {
        list.addEventListener("change", onChange);
        return () => list.removeEventListener("change", onChange);
      }

      list.addListener(onChange);
      return () => list.removeListener(onChange);
    },
    [query]
  );

  return useSyncExternalStore(
    subscribe,
    () => getMediaQueryList(query)?.matches ?? false,
    () => false
  );
};

/** Matches the breakpoint where the app shell switches to the desktop side rail. */
export const RAIL_MEDIA_QUERY = "(min-width: 1024px)";
