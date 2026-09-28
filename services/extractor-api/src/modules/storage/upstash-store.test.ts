import { afterEach, describe, expect, it, vi } from "vitest";

import { extractorApiEnv } from "../../config/env.js";

import {
  addStoreSetMembers,
  countStoreKeys,
  deleteStoreKeys,
  getStoreString,
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
