import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(", ");

interface ModalFocusTrapOptions {
  /** Whether the modal is on screen. */
  active: boolean;
  /** The dialog element. Give it `tabIndex={-1}` so it can hold focus itself. */
  containerRef: RefObject<HTMLElement | null>;
  /** Called on Escape. Omit when the modal handles Escape itself. */
  onEscape?: (() => void) | undefined;
}

/**
 * Moves focus into a modal, keeps Tab inside it, and restores focus to the
 * previously focused element on close. Without this, keyboard users tab
 * straight out of a portalled dialog into the page behind it.
 */
export const useModalFocusTrap = ({
  active,
  containerRef,
  onEscape
}: ModalFocusTrapOptions): void => {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) {
      return;
    }

    const container = containerRef.current;

    if (!container) {
      return;
    }

    const previouslyFocusedElement = document.activeElement;
    const getFocusableElements = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true"
      );

    (getFocusableElements()[0] ?? container).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onEscapeRef.current?.();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const activeElement = document.activeElement;

      // A nested layer (a confirmation dialog on top) owns focus; leave it be.
      if (activeElement && activeElement !== document.body && !container.contains(activeElement)) {
        return;
      }

      const focusableElements = getFocusableElements();
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (!firstElement || !lastElement) {
        event.preventDefault();
        container.focus();
        return;
      }

      if (!activeElement || activeElement === document.body) {
        event.preventDefault();
        (event.shiftKey ? lastElement : firstElement).focus();
        return;
      }

      if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);

      if (previouslyFocusedElement instanceof HTMLElement) {
        previouslyFocusedElement.focus();
      }
    };
  }, [active, containerRef]);
};
