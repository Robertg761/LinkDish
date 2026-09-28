import { afterEach, describe, expect, it, vi } from "vitest";

import {
  estimateInp,
  getWebVitalsSnapshot,
  resetWebVitalsForTests,
  startWebVitalsObserver
} from "./web-vitals";

const analytics = vi.hoisted(() => ({
  flushAnalytics: vi.fn(),
  trackWebEvent: vi.fn<(event: unknown) => void>()
}));
vi.mock("./client", () => analytics);

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};

/** A PerformanceObserver that reports one LCP entry and one layout shift as soon as it observes. */
class FakePerformanceObserver {
  static supportedEntryTypes = ["largest-contentful-paint", "layout-shift"];

  constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {}

  observe(options: { type: string }) {
    const entries =
      options.type === "largest-contentful-paint"
        ? [{ renderTime: 812.4, startTime: 800 }]
        : [{ hadRecentInput: false, startTime: 100, value: 0.0512 }];
    this.callback({ getEntries: () => entries });
  }
}

describe("web vitals", () => {
  afterEach(() => {
    resetWebVitalsForTests();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "visibilityState");
    analytics.trackWebEvent.mockReset();
    analytics.flushAnalytics.mockReset();
  });

  it("estimates INP as the ~98th percentile interaction", () => {
    expect(estimateInp([])).toBeUndefined();
    expect(estimateInp([40, 120, 80])).toBe(120);

    const many = Array.from({ length: 100 }, (_, index) => index + 1);
    // Two of the slowest interactions per hundred are ignored.
    expect(estimateInp(many)).toBe(98);
  });

  it("starts safely where PerformanceObserver is missing or partial", () => {
    expect(() => startWebVitalsObserver()).not.toThrow();
    expect(() => startWebVitalsObserver()).not.toThrow();
    expect(getWebVitalsSnapshot()).toEqual(expect.any(Object));
  });

  it("sends the measured vitals once, when the page is first hidden", () => {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    startWebVitalsObserver();
    expect(analytics.trackWebEvent).not.toHaveBeenCalled();

    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");

    expect(analytics.trackWebEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        eventName: "web_vitals",
        properties: { metric: "LCP", value: 812 }
      }),
      expect.objectContaining({
        eventName: "web_vitals",
        properties: { metric: "CLS", value: 0.0512 }
      })
    ]);
    // Sent with the page-hide beacon, so leaving the page does not lose them.
    expect(analytics.flushAnalytics).toHaveBeenCalledWith({ useBeacon: true });
  });
});
