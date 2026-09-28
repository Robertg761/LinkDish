import { useRef } from "react";

import type React from "react";

/**
 * Keyboard behaviour for a custom `role="radiogroup"` of `role="radio"` buttons (the pattern
 * SegmentedControl uses): one Tab stop — the checked option, or the first when none is — and
 * Arrow keys, Home and End move focus and selection together, as screen readers expect.
 */
export interface RovingRadioProps {
  ref: (element: HTMLElement | null) => void;
  tabIndex: 0 | -1;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

export function useRovingRadioGroup<T>(
  values: readonly T[],
  selected: T | null | undefined,
  onSelect: (value: T) => void
): (index: number) => RovingRadioProps {
  const elements = useRef<Array<HTMLElement | null>>([]);
  const selectedIndex = selected == null ? -1 : values.indexOf(selected);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  return (index) => ({
    onKeyDown: (event) => {
      const count = values.length;
      let next: number | null = null;

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = (index + 1) % count;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = (index - 1 + count) % count;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = count - 1;
      }

      const value = next === null ? undefined : values[next];

      if (next === null || value === undefined) {
        return;
      }

      event.preventDefault();
      onSelect(value);
      elements.current[next]?.focus();
    },
    ref: (element) => {
      elements.current[index] = element;
    },
    tabIndex: index === tabStop ? 0 : -1
  });
}
