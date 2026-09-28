/**
 * After an in-app navigation, keyboard and screen-reader users land on the new page's main
 * heading (a screen reader reads it out), the way a full page load would start at the top. Lazy
 * pages may take a moment to render, so this waits (a few seconds at most) until the page — not
 * its loading skeleton — has an <h1>. Returns a cancel function.
 */

export const ROUTE_FOCUS_TIMEOUT_MS = 3000;

export interface FocusPageHeadingOptions {
  /** Called when focus had to fall back to <main> (no heading, or it never rendered). */
  onFallback?: ((main: HTMLElement) => void) | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  requestFrame?: ((callback: () => void) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
}

const findHeading = (main: HTMLElement): HTMLElement | null => {
  // The Suspense fallback (and its skeleton title) is not the page yet.
  if (main.querySelector("[data-route-fallback]")) {
    return null;
  }

  return main.querySelector<HTMLElement>("h1");
};

export const focusPageHeading = ({
  cancelFrame = (handle) => window.cancelAnimationFrame(handle),
  now = () => performance.now(),
  onFallback,
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  timeoutMs = ROUTE_FOCUS_TIMEOUT_MS
}: FocusPageHeadingOptions = {}): (() => void) => {
  const startedAt = now();
  let frame = 0;
  let cancelled = false;

  const attempt = () => {
    if (cancelled) {
      return;
    }

    const main = document.getElementById("main-content");

    if (!main) {
      return;
    }

    // A dialog opened meanwhile (e.g. the palette): it owns focus.
    if (document.querySelector("[aria-modal='true']")) {
      return;
    }

    const heading = findHeading(main);

    if (heading) {
      if (!heading.hasAttribute("tabindex")) {
        heading.setAttribute("tabindex", "-1");
      }

      heading.focus({ preventScroll: true });
      return;
    }

    if (now() - startedAt >= timeoutMs) {
      main.focus({ preventScroll: true });
      onFallback?.(main);
      return;
    }

    frame = requestFrame(attempt);
  };

  attempt();

  return () => {
    cancelled = true;

    if (frame) {
      cancelFrame(frame);
    }
  };
};

/** "Shopping list · LinkDish" → "Shopping list". */
export const pageNameFromTitle = (title: string): string =>
  title.replace(/\s*·\s*LinkDish$/u, "").trim() || "LinkDish";
