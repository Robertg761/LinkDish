import { useLayoutEffect } from "react";

import type { RefObject } from "react";

const supportsFieldSizing = (): boolean => {
  try {
    return typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
  } catch {
    return false;
  }
};

/**
 * Grows a textarea with its content, so only the page (or sheet) scrolls, never a box inside it.
 * Uses CSS `field-sizing: content` where the browser has it (see Field.css) and measures
 * scrollHeight otherwise. The CSS min-height still applies.
 */
export const useAutosizeTextarea = (
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  enabled = true
): void => {
  useLayoutEffect(() => {
    const element = ref.current;

    if (!enabled || !element || supportsFieldSizing()) {
      return;
    }

    element.style.height = "auto";
    const borders = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borders}px`;
  }, [enabled, ref, value]);
};
