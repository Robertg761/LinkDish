import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebouncedWriter } from "./debouncedWriter";

describe("createDebouncedWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid schedules into one write of the latest value", async () => {
    const write = vi.fn(() => Promise.resolve());
    const writer = createDebouncedWriter(write, 250);

    writer.schedule(1);
    writer.schedule(2);
    writer.schedule(3);

    expect(write).not.toHaveBeenCalled();
    expect(writer.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(250);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(3);
    expect(writer.hasPending()).toBe(false);
  });

  it("flushes a pending value immediately, for example when the app backgrounds", async () => {
    const write = vi.fn(() => Promise.resolve());
    const writer = createDebouncedWriter(write, 10_000);

    writer.schedule("latest");
    await writer.flush();

    expect(write).toHaveBeenCalledWith("latest");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps writes in order and keeps going after a failed write", async () => {
    const written: string[] = [];
    const write = vi.fn((value: string) => {
      if (value === "bad") {
        return Promise.reject(new Error("disk full"));
      }

      written.push(value);
      return Promise.resolve();
    });
    const writer = createDebouncedWriter(write, 100);

    writer.schedule("bad");
    await expect(writer.flush()).rejects.toThrow("disk full");
    writer.schedule("good");
    await writer.flush();

    expect(written).toEqual(["good"]);
  });

  it("drops a pending value on cancel", async () => {
    const write = vi.fn(() => Promise.resolve());
    const writer = createDebouncedWriter(write, 100);

    writer.schedule(1);
    writer.cancel();
    await vi.advanceTimersByTimeAsync(100);
    await writer.flush();

    expect(write).not.toHaveBeenCalled();
  });
});
