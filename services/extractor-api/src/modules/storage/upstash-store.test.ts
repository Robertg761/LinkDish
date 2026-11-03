import { afterEach, describe, expect, it, vi } from "vitest";

import { extractorApiEnv } from "../../config/env.js";

import {
  addStoreSetMembers,
  countStoreKeys,
  deleteStoreKeys,
  getStoreString,
  runStoreTransaction,
  setStoreString,
  setStoreStringUnlessBlocked
} from "./upstash-store.js";

const originalUpstashUrl = extractorApiEnv.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = extractorApiEnv.UPSTASH_REDIS_REST_TOKEN;

describe("countStoreKeys", () => {
  it("counts memory keys matching a glob pattern", async () => {
    await setStoreString("linkdish-test:user:v1:alpha", "a");
    await setStoreString("linkdish-test:user:v1:beta", "b");
    await setStoreString("linkdish-test:session:v1:gamma", "c");
    await addStoreSetMembers("linkdish-test:user-sessions:v1:alpha", "s1");

    expect(await countStoreKeys("linkdish-test:user:v1:*")).toBe(2);
    expect(await countStoreKeys("linkdish-test:missing:*")).toBe(0);

    await deleteStoreKeys("linkdish-test:user:v1:alpha");

    expect(await countStoreKeys("linkdish-test:user:v1:*")).toBe(1);
  });

  it("does not treat glob pattern characters as regex", async () => {
    await setStoreString("linkdish-test:dot.key:v1:one", "a");

    expect(await countStoreKeys("linkdish-test:dotXkey:*")).toBe(0);
    expect(await countStoreKeys("linkdish-test:dot.key:*")).toBe(1);
  });
});

describe("memory store commands used by library sync", () => {
  it("increments by a step, counts set members and reads a sorted set by score", async () => {
    const results = await runStoreTransaction([
      ["INCRBY", "linkdish-test:rev:v1:a", "3"],
      ["INCRBY", "linkdish-test:rev:v1:a", "2"],
      ["SADD", "linkdish-test:live:v1:a", "x", "y"],
      ["SCARD", "linkdish-test:live:v1:a"],
      ["SCARD", "linkdish-test:live:v1:missing"],
      ["ZADD", "linkdish-test:feed:v1:a", "1", "one", "2", "two", "3", "three", "4", "four"],
      ["ZRANGEBYSCORE", "linkdish-test:feed:v1:a", "(1", "+inf", "WITHSCORES", "LIMIT", "0", "2"],
      ["ZRANGEBYSCORE", "linkdish-test:feed:v1:a", "3", "4"],
      ["ZRANGEBYSCORE", "linkdish-test:feed:v1:missing", "(0", "+inf"]
    ]);

    expect(results.map((result) => result.result)).toEqual([
      3,
      5,
      2,
      2,
      0,
      4,
      ["two", "2", "three", "3"],
      ["three", "four"],
      []
    ]);
  });
});

describe("memory ZREMRANGEBYRANK", () => {
  it("trims only beyond the kept size, matching Redis rank semantics", async () => {
    const key = "linkdish-test:zremrangebyrank";
    await runStoreTransaction(
      Array.from({ length: 5 }, (_, index) => ["ZADD", key, String(index), `m${index}`])
    );

    const [underCap] = await runStoreTransaction([["ZREMRANGEBYRANK", key, "0", "-7"]]);
    expect(underCap?.result).toBe(0);

    const [overCap] = await runStoreTransaction([["ZREMRANGEBYRANK", key, "0", "-4"]]);
    const [remaining] = await runStoreTransaction([["ZRANGE", key, "0", "-1"]]);
    expect(overCap?.result).toBe(2);
    expect(remaining?.result).toEqual(["m2", "m3", "m4"]);
  });
});

describe("setStoreStringUnlessBlocked", () => {
  afterEach(() => {
    extractorApiEnv.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
    extractorApiEnv.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
    vi.unstubAllGlobals();
  });

  it("writes only while the blocker key is absent (memory store)", async () => {
    await expect(
      setStoreStringUnlessBlocked("linkdish-test:plan:v1:a", "plus", "linkdish-test:block:v1:a", {
        ttlSeconds: 60
      })
    ).resolves.toBe(true);
    await expect(getStoreString("linkdish-test:plan:v1:a")).resolves.toBe("plus");

    await setStoreString("linkdish-test:block:v1:b", "1", { ttlSeconds: 60 });
    await expect(
      setStoreStringUnlessBlocked("linkdish-test:plan:v1:b", "plus", "linkdish-test:block:v1:b", {
        ttlSeconds: 60
      })
    ).resolves.toBe(false);
    await expect(getStoreString("linkdish-test:plan:v1:b")).resolves.toBeNull();
  });

  it("checks the blocker and writes in one atomic EVAL on Upstash", async () => {
    extractorApiEnv.UPSTASH_REDIS_REST_URL = "https://upstash.test";
    extractorApiEnv.UPSTASH_REDIS_REST_TOKEN = "token";
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return Promise.resolve(new Response(JSON.stringify([{ result: 0 }]), { status: 200 }));
      })
    );

    await expect(
      setStoreStringUnlessBlocked("plan-key", "family", "block-key", {
        ttlSeconds: 300,
        timeoutMs: 1_000
      })
    ).resolves.toBe(false);

    const body = JSON.parse(requests[0]?.body ?? "[]") as string[][];
    expect(requests[0]?.url).toBe("https://upstash.test/multi-exec");
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual([
      "EVAL",
      expect.stringContaining("redis.call('EXISTS', KEYS[2])") as string,
      "2",
      "plan-key",
      "block-key",
      "family",
      "300"
    ]);
  });
});
