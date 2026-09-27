/**
 * Records Core Web Vitals (LCP, INP, CLS) with PerformanceObserver — no library.
 *
 * Values are kept in memory only. The analytics contract has no event these fit (reusing
 * `web_route_viewed` or `client_error` would distort those metrics), so nothing is sent until a
 * dedicated event name exists in `analyticsEventNameSchema`. Use `getWebVitalsSnapshot()` or
 * `subscribeWebVitals()` (fires with the final values when the page is hidden).
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
