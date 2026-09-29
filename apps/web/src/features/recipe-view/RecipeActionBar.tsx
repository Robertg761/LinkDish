import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTimerDockLift } from "../cook-mode/use-timer-dock-lift";

import "./RecipeActionBar.css";

interface RecipeActionBarProps {
  children: React.ReactNode;
  label?: string | undefined;
}

/**
 * Phones and tablets: a floating action bar pinned above the tab bar with the one primary action
 * ("Start cooking") in thumb reach, plus a few icon buttons. The timer dock rises above it.
 */
export const RecipeActionBar: React.FC<RecipeActionBarProps> = ({
  children,
  label = "Recipe actions"
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = barRef.current;

    if (!element) {
      return;
    }

    const measure = () => setHeight(element.getBoundingClientRect().height || null);
    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useTimerDockLift(height == null ? null : height + 10);

  // Portalled: the page wrapper animates with a transform, which would otherwise become the
  // containing block of this fixed bar.
  return (
    <>
      <div aria-hidden="true" className="recipe-action-bar-spacer" />
      {createPortal(
        <div aria-label={label} className="recipe-action-bar print-hide" ref={barRef} role="group">
          {children}
        </div>,
        document.body
      )}
    </>
  );
};
