import { afterEach, describe, expect, it, vi } from "vitest";

import { createRequestDeadline } from "./deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestDeadline", () => {
  it("aborts when the deadline passes and sizes step budgets from the time left", () => {
    vi.useFakeTimers();
    const deadline = createRequestDeadline(50_000);

    expect(deadline.budgetMs(10_000)).toBe(10_000);
    expect(deadline.budgetMs(30_000, 25_000)).toBe(25_000);

    vi.advanceTimersByTime(45_000);

    expect(deadline.remainingMs()).toBe(5_000);
    expect(deadline.budgetMs(30_000, 1_500)).toBe(3_500);
    expect(deadline.signal.aborted).toBe(false);

    vi.advanceTimersByTime(5_000);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.budgetMs(30_000)).toBe(0);
    deadline.dispose();
  });

  it("follows a parent cancellation", () => {
    const parent = new AbortController();
    const deadline = createRequestDeadline(50_000, parent.signal);

    parent.abort(new Error("billing denied"));

    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController();
    parent.abort();

    const deadline = createRequestDeadline(50_000, parent.signal);

    expect(deadline.signal.aborted).toBe(true);
    deadline.dispose();
  });
});
