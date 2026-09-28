import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armBootSettle,
  BootRouteRendered,
  holdBootSettle,
  isBootSettled,
  LOAD_WAIT_CAP_MS,
  markRouteRendered,
  resetBootSettleForTests,
  SETTLE_CAP_MS,
  useBootSettled,
  useBootSettleHold,
  whenBootSettled
} from "./boot-settle";

/** requestAnimationFrame → setTimeout 0 → idle (a 50 ms timer without requestIdleCallback). */
const flushPaintAndIdle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
};

describe("boot settle gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBootSettleForTests();
  });

  afterEach(() => {
    resetBootSettleForTests();
    vi.useRealTimers();
  });

  it("runs deferred work on the next task when the gate was never armed (tests, tools)", async () => {
    const task = vi.fn();

    expect(isBootSettled()).toBe(true);
    whenBootSettled(task);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("waits for the page to render and every hold to be released", async () => {
    armBootSettle();
    const task = vi.fn();
    whenBootSettled(task);

    const release = holdBootSettle();
    markRouteRendered();
    await flushPaintAndIdle();
    expect(task).not.toHaveBeenCalled();
    expect(isBootSettled()).toBe(false);

    release();
    await flushPaintAndIdle();
    expect(task).toHaveBeenCalledTimes(1);
    expect(isBootSettled()).toBe(true);

    // Later work runs straight away (on the next task).
    const later = vi.fn();
    whenBootSettled(later);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("stays shut until the route's page has rendered", async () => {
    armBootSettle();
    const task = vi.fn();
    whenBootSettled(task);

    await flushPaintAndIdle();
    expect(task).not.toHaveBeenCalled();

    markRouteRendered();
    await flushPaintAndIdle();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("waits for the load event, but not forever", async () => {
    const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    armBootSettle();
    const task = vi.fn();
    whenBootSettled(task);
    markRouteRendered();

    await flushPaintAndIdle();
    expect(task).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_WAIT_CAP_MS);
    });
    await flushPaintAndIdle();
    expect(task).toHaveBeenCalledTimes(1);
    readyState.mockRestore();
  });

  it("opens after the cap even if a page never lets go", async () => {
    armBootSettle();
    const task = vi.fn();
    whenBootSettled(task);
    holdBootSettle();
    markRouteRendered();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_CAP_MS);
    });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("drops cancelled work", async () => {
    armBootSettle();
    const task = vi.fn();
    const cancel = whenBootSettled(task);
    cancel();
    markRouteRendered();

    await flushPaintAndIdle();
    expect(task).not.toHaveBeenCalled();
    expect(isBootSettled()).toBe(true);
  });

  it("re-renders components once settled, after the page's hold and its route signal", async () => {
    armBootSettle();

    const Page: React.FC<{ loading: boolean }> = ({ loading }) => {
      useBootSettleHold(loading);
      return <p>{loading ? "Loading" : "Recipes"}</p>;
    };
    const Deferred: React.FC = () => (useBootSettled() ? <p>Timer dock</p> : null);
    const Tree: React.FC<{ loading: boolean }> = ({ loading }) => (
      <>
        <Page loading={loading} />
        <BootRouteRendered />
        <Deferred />
      </>
    );

    const { rerender } = render(<Tree loading />);
    await flushPaintAndIdle();
    expect(screen.queryByText("Timer dock")).not.toBeInTheDocument();

    rerender(<Tree loading={false} />);
    await flushPaintAndIdle();
    expect(screen.getByText("Timer dock")).toBeInTheDocument();
  });
});
