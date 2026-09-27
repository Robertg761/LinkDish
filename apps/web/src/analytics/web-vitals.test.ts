import { describe, expect, it } from "vitest";

import { estimateInp, getWebVitalsSnapshot, startWebVitalsObserver } from "./web-vitals";

describe("web vitals", () => {
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
});
