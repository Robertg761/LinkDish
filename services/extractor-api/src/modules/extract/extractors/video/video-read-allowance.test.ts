import { describe, expect, it, vi } from "vitest";

import { createDailyVideoReadAllowance, getVideoReadCounterKey } from "./video-read-allowance";

describe("createDailyVideoReadAllowance", () => {
  it("allows reads up to the daily limit, then refuses them", async () => {
    const allowance = createDailyVideoReadAllowance({
      dailyLimit: 2,
      now: () => new Date("2031-01-02T10:00:00Z")
    });

    expect(await allowance.reserve()).toBe(true);
    expect(await allowance.reserve()).toBe(true);
    expect(await allowance.reserve()).toBe(false);
  });

  it("starts a new count each UTC day", async () => {
    let now = new Date("2031-02-03T23:59:00Z");
    const allowance = createDailyVideoReadAllowance({ dailyLimit: 1, now: () => now });

    expect(await allowance.reserve()).toBe(true);
    expect(await allowance.reserve()).toBe(false);

    now = new Date("2031-02-04T00:01:00Z");

    expect(await allowance.reserve()).toBe(true);
  });

  it("refuses every read when the limit is 0, without touching the store", async () => {
    const runTransaction = vi.fn();
    const allowance = createDailyVideoReadAllowance({ dailyLimit: 0, runTransaction });

    expect(await allowance.reserve()).toBe(false);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("counts under one key per day that expires after two days", async () => {
    const runTransaction = vi.fn(() => Promise.resolve([{ result: 1 }, { result: 1 }]));
    const allowance = createDailyVideoReadAllowance({
      dailyLimit: 5,
      now: () => new Date("2031-03-04T12:00:00Z"),
      runTransaction
    });

    await allowance.reserve();

    expect(getVideoReadCounterKey(new Date("2031-03-04T12:00:00Z"))).toBe(
      "linkdish:video-reader:reads:v1:2031-03-04"
    );
    expect(runTransaction).toHaveBeenCalledWith(
      [
        ["INCR", "linkdish:video-reader:reads:v1:2031-03-04"],
        ["EXPIRE", "linkdish:video-reader:reads:v1:2031-03-04", "172800", "NX"]
      ],
      { timeoutMs: 1_500 }
    );
  });

  it("throws when the store gives no count, so the caller can skip the read", async () => {
    const allowance = createDailyVideoReadAllowance({
      dailyLimit: 5,
      runTransaction: () => Promise.resolve([{ error: "WRONGTYPE" }, { result: 0 }])
    });

    await expect(allowance.reserve()).rejects.toThrow("WRONGTYPE");
  });
});
