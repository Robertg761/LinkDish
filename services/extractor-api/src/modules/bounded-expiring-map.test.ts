import { describe, expect, it } from "vitest";

import { createBoundedExpiringMap } from "./bounded-expiring-map";

describe("createBoundedExpiringMap", () => {
  it("drops entries once they expire", () => {
    const store = createBoundedExpiringMap<number>({ maxEntries: 100 });

    store.set("a", 1, 1_000, 0);
    expect(store.get("a", 500)).toBe(1);
    expect(store.get("a", 1_000)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("prunes expired entries in bulk", () => {
    const store = createBoundedExpiringMap<number>({ maxEntries: 100 });

    for (let index = 0; index < 50; index += 1) {
      store.set(`key-${index}`, index, 1_000, 0);
    }

    store.set("keeper", 1, 10_000, 0);
    expect(store.size()).toBe(51);
    expect(store.prune(2_000)).toBe(50);
    expect(store.size()).toBe(1);
    expect(store.get("keeper", 2_000)).toBe(1);
  });

  it("never grows past the hard entry cap even without expiries", () => {
    const store = createBoundedExpiringMap<number>({ maxEntries: 10 });

    for (let index = 0; index < 500; index += 1) {
      store.set(`key-${index}`, index, null, index);
    }

    expect(store.size()).toBeLessThanOrEqual(10);
    expect(store.get("key-499", 500)).toBe(499);
    expect(store.get("key-0", 500)).toBeUndefined();
  });

  it("prunes on the configured interval even while under the cap", () => {
    const store = createBoundedExpiringMap<number>({
      maxEntries: 1_000,
      pruneIntervalMs: 60_000
    });

    for (let index = 0; index < 20; index += 1) {
      store.set(`key-${index}`, index, 1_000, 0);
    }

    expect(store.size()).toBe(20);
    store.set("later", 1, 130_000, 120_000);
    expect(store.size()).toBe(1);
  });
});
