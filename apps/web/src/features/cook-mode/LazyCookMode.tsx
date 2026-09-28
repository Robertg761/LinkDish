import React, { Suspense, useEffect, useState } from "react";

import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";

import type { CookModeProps } from "./CookMode";

const CookModeChunk = lazyWithRetry(() =>
  import("./CookMode").then((module) => ({ default: module.CookMode }))
);

const IDLE_PRELOAD_DELAY_MS = 2500;

/** Starts downloading cook mode (e.g. on hover of "Start cooking"). */
export const preloadCookMode = (): void => {
  void CookModeChunk.preload().catch(() => undefined);
};

/**
 * Cook mode, loaded on demand: its code is fetched while the page is idle (or on first open)
 * instead of weighing down the recipe page, and it stays mounted after the first open so
 * closing it keeps focus restoration and resume state intact.
 */
export const LazyCookMode: React.FC<CookModeProps> = (props) => {
  const [mounted, setMounted] = useState(props.open);

  useEffect(() => {
    if (props.open) {
      setMounted(true);
    }
  }, [props.open]);

  useEffect(() => {
    const idle = window.requestIdleCallback;

    if (typeof idle === "function") {
      const id = idle(preloadCookMode, { timeout: IDLE_PRELOAD_DELAY_MS * 2 });
      return () => window.cancelIdleCallback?.(id);
    }

    const timeoutId = window.setTimeout(preloadCookMode, IDLE_PRELOAD_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!mounted && !props.open) {
    return null;
  }

  return (
    <OptionalChunkBoundary name="Cook mode">
      <Suspense fallback={null}>
        <CookModeChunk {...props} />
      </Suspense>
    </OptionalChunkBoundary>
  );
};
