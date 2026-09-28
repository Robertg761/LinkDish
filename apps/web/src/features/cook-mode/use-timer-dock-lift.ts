import { useEffect } from "react";

const LIFT_PROPERTY = "--timer-dock-lift";

/**
 * Raises the floating timer dock by `pixels` while the calling page shows its own bottom bar
 * (e.g. the recipe action bar), so the two never overlap.
 */
export const useTimerDockLift = (pixels: number | null): void => {
  useEffect(() => {
    if (pixels == null || pixels <= 0) {
      return;
    }

    const root = document.documentElement;
    root.style.setProperty(LIFT_PROPERTY, `${Math.round(pixels)}px`);

    return () => {
      root.style.removeProperty(LIFT_PROPERTY);
    };
  }, [pixels]);
};
