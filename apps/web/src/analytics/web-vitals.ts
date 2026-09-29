import { flushAnalytics, trackWebEvent } from "./client";

/**
 * Records Core Web Vitals (LCP, INP, CLS) with PerformanceObserver — no library.
 *
 * The first time the page is hidden, each measured value is sent once as a `web_vitals` event
 * (`{ metric: "LCP" | "INP" | "CLS", value }`) with the page-hide beacon. `getWebVitalsSnapshot()`
 * and `subscribeWebVitals()` (fires with the latest values whenever the page is hidden) expose
 * them too.
 */

export interface WebVitalsSnapshot {
  /** Cumulative Layout Shift: the largest session window of unexpected shifts. */
  cls?: number | undefined;
  /** Interaction to Next Paint in ms (≈ 98th percentile of interaction latency). */
  inpMs?: number | undefined;
  /** Largest Contentful Paint in ms. */
  lcpMs?: number | undefined;
}

interface LayoutShiftEntry extends PerformanceEntry {
  hadRecentInput: boolean;
  value: number;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
}

interface LcpEntry extends PerformanceEntry {
  renderTime?: number;
}

let started = false;
let reported = false;
let snapshot: WebVitalsSnapshot = {};
let lcpFinal = false;
const listeners = new Set<(snapshot: WebVitalsSnapshot) => void>();

// CLS session windows: shifts less than 1s apart, windows at most 5s long.
let clsWindowValue = 0;
let clsWindowStart = 0;
let clsWindowLast = 0;

// Longest duration seen per interaction.
const interactionDurations = new Map<number, number>();

const round = (value: number, digits = 0): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const observe = (type: string, callback: (entries: PerformanceEntry[]) => void, extra = {}) => {
  try {
    const supported = PerformanceObserver.supportedEntryTypes ?? [];

    if (!supported.includes(type)) {
      return;
    }

    const observer = new PerformanceObserver((list) => {
      callback(list.getEntries());
    });
    observer.observe({ buffered: true, type, ...extra } as PerformanceObserverInit);
  } catch {
    // Unsupported entry types or options: skip that metric.
  }
};

const handleLcp = (entries: PerformanceEntry[]) => {
  if (lcpFinal) {
    return;
  }

  const last = entries.at(-1) as LcpEntry | undefined;

  if (last) {
    snapshot = { ...snapshot, lcpMs: round(last.renderTime || last.startTime) };
  }
};

const handleLayoutShift = (entries: PerformanceEntry[]) => {
  for (const entry of entries as LayoutShiftEntry[]) {
    if (entry.hadRecentInput) {
      continue;
    }

    const continuesWindow =
      clsWindowValue > 0 &&
      entry.startTime - clsWindowLast < 1000 &&
      entry.startTime - clsWindowStart < 5000;

    if (continuesWindow) {
      clsWindowValue += entry.value;
    } else {
      clsWindowValue = entry.value;
      clsWindowStart = entry.startTime;
    }

    clsWindowLast = entry.startTime;
    snapshot = { ...snapshot, cls: round(Math.max(snapshot.cls ?? 0, clsWindowValue), 4) };
  }
};

/** INP ≈ the 98th percentile: skip one of the slowest interactions per 50. */
export const estimateInp = (durations: readonly number[]): number | undefined => {
  if (!durations.length) {
    return undefined;
  }

  const sorted = [...durations].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 50))];
};

const handleEvents = (entries: PerformanceEntry[]) => {
  for (const entry of entries as EventTimingEntry[]) {
    if (!entry.interactionId) {
      continue;
    }

    const previous = interactionDurations.get(entry.interactionId) ?? 0;
    interactionDurations.set(entry.interactionId, Math.max(previous, entry.duration));
  }

  const inp = estimateInp(Array.from(interactionDurations.values()));

  if (inp !== undefined) {
    snapshot = { ...snapshot, inpMs: round(inp) };
  }
};

const finalizeLcp = () => {
  lcpFinal = true;
};

const reportFinal = () => {
  if (document.visibilityState !== "hidden") {
    return;
  }

  finalizeLcp();
  const current = getWebVitalsSnapshot();
  listeners.forEach((listener) => {
    try {
      listener(current);
    } catch {
      // Listeners must not break page hide handling.
    }
  });
};

/** Sends the page's vitals once per page load (LCP in ms, INP in ms, CLS unitless). */
const reportOnce = (current: WebVitalsSnapshot) => {
  const metrics: Array<[metric: "LCP" | "INP" | "CLS", value: number | undefined]> = [
    ["LCP", current.lcpMs],
    ["INP", current.inpMs],
    ["CLS", current.cls]
  ];
  const measured = metrics.filter((entry): entry is ["LCP" | "INP" | "CLS", number] =>
    Number.isFinite(entry[1])
  );

  if (reported || measured.length === 0) {
    return;
  }

  reported = true;

  for (const [metric, value] of measured) {
    trackWebEvent({
      eventName: "web_vitals",
      properties: { metric, value },
      routeOrScreen: window.location.pathname
    });
  }

  // The page may never be visible again: send now, the way page-hide flushes do.
  flushAnalytics({ useBeacon: true });
};

/** Starts observing (idempotent, safe to call where PerformanceObserver is missing). */
export function startWebVitalsObserver(): void {
  if (started || typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
    return;
  }

  started = true;
  observe("largest-contentful-paint", handleLcp);
  observe("layout-shift", handleLayoutShift);
  observe("event", handleEvents, { durationThreshold: 40 });
  observe("first-input", handleEvents);

  // LCP stops updating once the user interacts.
  window.addEventListener("pointerdown", finalizeLcp, { capture: true, once: true });
  window.addEventListener("keydown", finalizeLcp, { capture: true, once: true });
  document.addEventListener("visibilitychange", reportFinal);
  listeners.add(reportOnce);
}

export function getWebVitalsSnapshot(): WebVitalsSnapshot {
  return { ...snapshot };
}

/** Called with the latest values each time the page becomes hidden. */
export function subscribeWebVitals(listener: (snapshot: WebVitalsSnapshot) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget observers, values and whether this page load already reported. */
export function resetWebVitalsForTests(): void {
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", reportFinal);
  }

  started = false;
  reported = false;
  lcpFinal = false;
  snapshot = {};
  clsWindowValue = 0;
  clsWindowStart = 0;
  clsWindowLast = 0;
  interactionDurations.clear();
  listeners.clear();
}
