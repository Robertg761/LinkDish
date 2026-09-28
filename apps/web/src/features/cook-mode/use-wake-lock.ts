import { useEffect } from "react";

/**
 * Keeps the screen on while `active`. Browsers release screen wake locks whenever the page is
 * hidden (switching apps or tabs), so the lock is requested again each time the page becomes
 * visible — the old cook mode never did, and phones went to sleep mid-recipe.
 */
export const useScreenWakeLock = (active: boolean): void => {
  useEffect(() => {
    const wakeLock = typeof navigator === "undefined" ? undefined : navigator.wakeLock;

    if (!active || !wakeLock) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let disposed = false;

    const acquire = async () => {
      if (
        disposed ||
        requesting ||
        document.visibilityState !== "visible" ||
        (sentinel && !sentinel.released)
      ) {
        return;
      }

      requesting = true;

      try {
        const next = await wakeLock.request("screen");

        if (disposed) {
          void next.release().catch(() => undefined);
          return;
        }

        sentinel = next;
      } catch {
        // Denied (battery saver, unsupported context). Cooking still works without it.
      } finally {
        requesting = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
};
