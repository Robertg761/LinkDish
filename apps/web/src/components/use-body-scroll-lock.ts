import { useEffect } from "react";

let lockCount = 0;
let previousOverflow = "";
let previousPaddingRight = "";

const lock = () => {
  if (lockCount === 0) {
    const { body, documentElement } = document;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    previousOverflow = body.style.overflow;
    previousPaddingRight = body.style.paddingRight;
    body.style.overflow = "hidden";

    // Keep the page from shifting sideways when the desktop scrollbar disappears.
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }

  lockCount += 1;
};

const unlock = () => {
  lockCount = Math.max(0, lockCount - 1);

  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow;
    document.body.style.paddingRight = previousPaddingRight;
  }
};

/**
 * Stops the page behind a modal from scrolling. Nested modals are reference
 * counted, so closing the top one keeps the lock until the last one closes.
 */
export const useBodyScrollLock = (active: boolean): void => {
  useEffect(() => {
    if (!active) {
      return;
    }

    lock();

    return unlock;
  }, [active]);
};
