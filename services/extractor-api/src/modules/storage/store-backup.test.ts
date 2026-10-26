import { describe, expect, it } from "vitest";

import { decryptBackup, encryptBackup, generateBackupKeyPair } from "./backup-crypto.js";
import {
  createStoreSnapshot,
  createUpstashPipeline,
  parseStoreSnapshot,
  restoreStoreSnapshot,
  type StorePipeline
} from "./store-backup.js";

/* Just enough Redis for the backup: strings, sets, sorted sets and TTLs, in one process. */
const createFakeRedis = (nowMs: () => number) => {
  const strings = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();
  const expiries = new Map<string, number>();
  const has = (key: string) => strings.has(key) || sets.has(key) || zsets.has(key);
  const del = (key: string) => {
    strings.delete(key);
    sets.delete(key);
    zsets.delete(key);
    expiries.delete(key);
  };
  const commands: string[][] = [];

  const runOne = (command: string[]): unknown => {
    const [name, key = "", ...args] = command;
    commands.push(command);

    switch (name) {
      case "SCAN": {
        // Two pages, to exercise the cursor.
        const all = [...new Set([...strings.keys(), ...sets.keys(), ...zsets.keys()])].sort();
        const half = Math.ceil(all.length / 2);
        return key === "0" ? ["7", all.slice(0, half)] : ["0", all.slice(half)];
      }
      case "GET":
        return strings.get(key) ?? null;
      case "MGET":
        return [key, ...args].map((name) => strings.get(name) ?? null);
      case "SMEMBERS":
        return [...(sets.get(key) ?? [])];
      case "ZRANGE":
        return [...(zsets.get(key) ?? new Map<string, number>())]
          .sort((left, right) => left[1] - right[1])
          .flatMap(([member, score]) =>
            args.includes("WITHSCORES") ? [member, String(score)] : [member]
          );
      case "PTTL": {
        if (!has(key)) return -2;
        const expiresAt = expiries.get(key);
        return expiresAt == null ? -1 : expiresAt - nowMs();
      }
      case "EXISTS":
        return has(key) ? 1 : 0;
      case "SET": {
        if (args.includes("NX") && has(key)) return null;
        del(key);
        strings.set(key, args[0] ?? "");
        const px = args.indexOf("PX");
        if (px >= 0) expiries.set(key, nowMs() + Number(args[px + 1]));
        return "OK";
      }
      case "DEL":
        [key, ...args].forEach(del);
        return 1;
      case "EVAL": {
        // The library lock scripts: renew (pexpire) or release KEYS[1] while it holds ARGV[1].
        const [, lockKey = "", token, ms] = args;
        if (strings.get(lockKey) !== token) return 0;
        if (key.includes("pexpire")) {
          expiries.set(lockKey, nowMs() + Number(ms));
        } else {
          del(lockKey);
        }
        return 1;
      }
      case "SADD": {
        const set = sets.get(key) ?? new Set<string>();
        args.forEach((member) => set.add(member));
        sets.set(key, set);
        return args.length;
      }
      case "ZADD": {
        const zset = zsets.get(key) ?? new Map<string, number>();
        const nx = args[0] === "NX";
        const pairs = nx ? args.slice(1) : args;
        for (let index = 0; index < pairs.length; index += 2) {
          const member = pairs[index + 1] ?? "";
          if (!(nx && zset.has(member))) zset.set(member, Number(pairs[index]));
        }
        zsets.set(key, zset);
        return pairs.length / 2;
      }
      case "PEXPIRE":
        expiries.set(key, nowMs() + Number(args[0]));
        return 1;
      case "RENAME": {
        const target = args[0] ?? "";
        if (!has(key)) throw new Error("ERR no such key");
        const [string, set, zset] = [strings.get(key), sets.get(key), zsets.get(key)];
        del(target);
        if (string != null) strings.set(target, string);
        if (set) sets.set(target, set);
        if (zset) zsets.set(target, zset);
        del(key);
        return "OK";
      }
      default:
        throw new Error(`Fake Redis does not know ${name}`);
    }
  };

  const run: StorePipeline = (batch) => Promise.resolve(batch.map(runOne));

  return { commands, expiries, run, sets, strings, zsets };
};

const seed = (redis: ReturnType<typeof createFakeRedis>, nowMs: number) => {
  redis.strings.set("linkdish:user:v1:u1", JSON.stringify({ id: "u1" }));
  redis.strings.set("linkdish:user-by-email:v1:hash", "u1");
  redis.strings.set("linkdish:session:v1:token", JSON.stringify({ userId: "u1" }));
  redis.expiries.set("linkdish:session:v1:token", nowMs + 60_000);
  redis.sets.set("linkdish:user-sessions:v1:u1", new Set(["token"]));
  redis.strings.set("linkdish:household:v1:h1", JSON.stringify({ id: "h1" }));
  redis.sets.set("linkdish:household-recipes:v1:h1", new Set(["r2", "r1"]));
  redis.strings.set("linkdish:library:v1:item:u1:recipe:a", JSON.stringify({ rev: 1 }));
  redis.zsets.set("linkdish:library:v1:changes:u1", new Map([["recipe:a", 1]]));
  redis.strings.set("linkdish:library:v1:rev:u1", "1");
  redis.strings.set("linkdish:quota:v2:lifetime:import:u1", "3");
  // Disposable
  redis.strings.set("linkdish:library:v1:lock:u1", "x");
  redis.strings.set("linkdish:extract-cache:v9:abc", "{}");
  redis.zsets.set("linkdish:quota:v2:lifetime:import:u1:pending", new Map([["t", 1]]));
  redis.strings.set("linkdish:quota:v2:2026-10:import:u1", "1");
  // Nobody classified this one
  redis.strings.set("linkdish:mystery:v1:thing", "?");
};

describe("createStoreSnapshot", () => {
  it("copies account data, leaves out disposable keys, and keeps TTLs", async () => {
    const nowMs = Date.parse("2026-10-26T00:00:00.000Z");
    const redis = createFakeRedis(() => nowMs);
    seed(redis, nowMs);

    const snapshot = await createStoreSnapshot(redis.run, {
      batchSize: 4,
      now: () => new Date(nowMs)
    });

    expect(snapshot.entries.map((entry) => entry.key)).toEqual([
      "linkdish:household-recipes:v1:h1",
      "linkdish:household:v1:h1",
      "linkdish:library:v1:changes:u1",
      "linkdish:library:v1:item:u1:recipe:a",
      "linkdish:library:v1:rev:u1",
      "linkdish:quota:v2:lifetime:import:u1",
      "linkdish:session:v1:token",
      "linkdish:user-by-email:v1:hash",
      "linkdish:user-sessions:v1:u1",
      "linkdish:user:v1:u1"
    ]);
    expect(
      snapshot.entries.find((entry) => entry.key.includes("household-recipes"))?.value
    ).toEqual(["r1", "r2"]);
    expect(snapshot.entries.find((entry) => entry.key.includes("changes"))?.value).toEqual([
      ["recipe:a", 1]
    ]);
    expect(snapshot.entries.find((entry) => entry.key.includes("session:"))?.expiresAt).toBe(
      new Date(nowMs + 60_000).toISOString()
    );
    expect(
      snapshot.entries.find((entry) => entry.key.includes(":user:"))?.expiresAt
    ).toBeUndefined();
    expect(snapshot.families.user).toBe(1);
    expect(snapshot.families["identity"]).toBe(0);
    expect(snapshot.skipped).toEqual({ "extract-cache": 1, library: 1, quota: 2 });
    expect(snapshot.unclassified).toEqual({ mystery: 1 });
    // Strings in one MGET per batch, never one GET per key (a library's counter aside).
    expect(
      redis.commands.some(([name, key]) => name === "GET" && !key?.includes(":library:"))
    ).toBe(false);
  });

  it("dates a TTL from when it was read, not from when the scan started", async () => {
    let clockMs = 0;
    const redis = createFakeRedis(() => clockMs);
    seed(redis, 0);
    const run: StorePipeline = (commands) => {
      // The scan takes 30 s; the session then has 30 s left.
      if (commands[0]?.[0] === "SCAN") clockMs = 30_000;
      return redis.run(commands);
    };

    const snapshot = await createStoreSnapshot(run, { now: () => new Date(clockMs) });

    expect(snapshot.createdAt).toBe(new Date(0).toISOString());
    expect(snapshot.entries.find((entry) => entry.key.includes("session:"))?.expiresAt).toBe(
      new Date(60_000).toISOString()
    );
  });

  it("reads a library again when a push lands in the middle of reading it", async () => {
    const redis = createFakeRedis(() => 0);
    seed(redis, 0);
    redis.sets.set("linkdish:library:v1:live:u1:recipe", new Set(["a"]));
    let pushed = false;
    const run: StorePipeline = (commands) => {
      if (!pushed && commands[0]?.[0] === "MGET" && commands[0][1]?.includes(":library:")) {
        // The push's counter bump and its transaction, between the two reads.
        pushed = true;
        redis.strings.set("linkdish:library:v1:rev:u1", "2");
        redis.strings.set("linkdish:library:v1:item:u1:recipe:a", JSON.stringify({ rev: 2 }));
        redis.zsets.get("linkdish:library:v1:changes:u1")?.set("recipe:a", 2);
      }
      return redis.run(commands);
    };

    const snapshot = await createStoreSnapshot(run, { libraryRetryDelayMs: 0 });
    const value = (key: string) => snapshot.entries.find((entry) => entry.key === key)?.value;

    expect(pushed).toBe(true);
    expect(value("linkdish:library:v1:rev:u1")).toBe("2");
    expect(value("linkdish:library:v1:changes:u1")).toEqual([["recipe:a", 2]]);
    expect(value("linkdish:library:v1:item:u1:recipe:a")).toBe(JSON.stringify({ rev: 2 }));
    expect(value("linkdish:library:v1:live:u1:recipe")).toEqual(["a"]);
    expect(snapshot.families["library-live"]).toBe(1);
  });

  it("leaves out keys deleted between the scan and the read", async () => {
    const redis = createFakeRedis(() => 0);
    redis.strings.set("linkdish:user:v1:u1", "{}");
    const run: StorePipeline = async (commands) => {
      if (commands[0]?.[0] === "MGET") {
        redis.strings.delete("linkdish:user:v1:u1");
      }
      return redis.run(commands);
    };

    const snapshot = await createStoreSnapshot(run);

    expect(snapshot.entries).toEqual([]);
  });
});

describe("restoreStoreSnapshot", () => {
  it("keeps sorted-set scores the live API wrote after the existence check", async () => {
    const index = "linkdish:ios-waitlist:v1:emails";
    const source = createFakeRedis(() => 0);
    source.zsets.set(index, new Map([["hash", 1]]));
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    const run: StorePipeline = (commands) => {
      if (commands[0]?.[0] !== "EXISTS") {
        // A sign-up lands between EXISTS and the restore's writes.
        target.zsets.set(index, new Map([["hash", 9]]));
      }
      return target.run(commands);
    };

    await restoreStoreSnapshot(run, snapshot, { apply: true, now: () => new Date(0) });

    expect(target.zsets.get(index)?.get("hash")).toBe(9);
  });

  it("restores a library under its lock, items before the feed", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    const lockKey = "linkdish:library:v1:lock:u1";
    const writes: Array<{ key: string; locked: boolean }> = [];
    const run: StorePipeline = (commands) => {
      for (const [name, key = ""] of commands) {
        if (
          ["SET", "SADD", "ZADD"].includes(name ?? "") &&
          key.includes(":library:") &&
          key !== lockKey
        ) {
          writes.push({ key, locked: target.strings.has(lockKey) });
        }
      }
      return target.run(commands);
    };

    await restoreStoreSnapshot(run, snapshot, { apply: true, now: () => new Date(0) });

    expect(writes.map(({ key }) => key)).toEqual([
      "linkdish:library:v1:item:u1:recipe:a",
      "linkdish:library:v1:rev:u1",
      "linkdish:library:v1:changes:u1"
    ]);
    expect(writes.every(({ locked }) => locked)).toBe(true);
    expect(target.strings.has(lockKey)).toBe(false);
  });

  it("waits for the API's library lock, and gives up if it stays held", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    const lockKey = "linkdish:library:v1:lock:u1";
    target.strings.set(lockKey, "push");
    let tries = 0;
    const run: StorePipeline = (commands) => {
      if (commands[0]?.[0] === "SET" && commands[0][1] === lockKey && (tries += 1) === 3) {
        target.strings.delete(lockKey);
      }
      return target.run(commands);
    };
    const options = { apply: true, keyPrefixes: ["linkdish:library:"], lockRetryDelayMs: 0 };

    await expect(
      restoreStoreSnapshot(run, snapshot, { ...options, lockAttempts: 2 })
    ).rejects.toThrow(/locked/u);
    await expect(restoreStoreSnapshot(run, snapshot, options)).resolves.toMatchObject({
      written: 3
    });
  });

  it("keeps items only the live library has, after the restored ones, with overwrite", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    target.strings.set("linkdish:library:v1:rev:u1", "5");
    target.strings.set("linkdish:library:v1:item:u1:recipe:a", JSON.stringify({ rev: 4 }));
    target.strings.set("linkdish:library:v1:item:u1:recipe:new", JSON.stringify({ rev: 5 }));
    target.zsets.set(
      "linkdish:library:v1:changes:u1",
      new Map([
        ["recipe:a", 4],
        ["recipe:new", 5]
      ])
    );
    target.sets.set("linkdish:library:v1:live:u1:recipe", new Set(["a", "new"]));

    await restoreStoreSnapshot(target.run, snapshot, { apply: true, overwrite: true });

    expect([...(target.zsets.get("linkdish:library:v1:changes:u1") ?? [])]).toEqual([
      ["recipe:a", 6],
      ["recipe:new", 7]
    ]);
    expect(target.strings.get("linkdish:library:v1:rev:u1")).toBe("7");
    expect(target.strings.get("linkdish:library:v1:item:u1:recipe:a")).toBe(
      JSON.stringify({ rev: 6 })
    );
    expect(target.strings.get("linkdish:library:v1:item:u1:recipe:new")).toBe(
      JSON.stringify({ rev: 7 })
    );
    // The snapshot had no live recipes; the kept one stays live.
    expect([...(target.sets.get("linkdish:library:v1:live:u1:recipe") ?? [])]).toEqual(["new"]);
  });

  it("keeps the live feed until an overwrite can finish, so a retry still keeps items", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    target.strings.set("linkdish:library:v1:rev:u1", "5");
    target.strings.set("linkdish:library:v1:item:u1:recipe:new", JSON.stringify({ rev: 5 }));
    target.zsets.set("linkdish:library:v1:changes:u1", new Map([["recipe:new", 5]]));
    target.sets.set("linkdish:library:v1:live:u1:recipe", new Set(["new"]));
    const failing: StorePipeline = (commands) =>
      commands.some(([name, , to]) => name === "RENAME" && to?.includes(":changes:"))
        ? Promise.reject(new Error("connection reset"))
        : target.run(commands);
    const options = {
      apply: true,
      batchSize: 1,
      keyPrefixes: ["linkdish:library:"],
      overwrite: true
    };

    await expect(restoreStoreSnapshot(failing, snapshot, options)).rejects.toThrow(
      /connection reset/u
    );
    // The old feed is untouched, and still leads to the kept item.
    expect([...(target.zsets.get("linkdish:library:v1:changes:u1") ?? [])]).toEqual([
      ["recipe:new", 5]
    ]);

    await restoreStoreSnapshot(target.run, snapshot, options);

    expect(
      [...(target.zsets.get("linkdish:library:v1:changes:u1") ?? [])].map(([member]) => member)
    ).toEqual(["recipe:a", "recipe:new"]);
    expect([...(target.sets.get("linkdish:library:v1:live:u1:recipe") ?? [])]).toEqual(["new"]);
    expect(target.strings.has("linkdish:library:v1:item:u1:recipe:new")).toBe(true);
    expect(target.strings.has("linkdish:library:v1:restoring:u1")).toBe(false);
  });

  it("renumbers above the snapshot's counter when the live one is lower", async () => {
    const source = createFakeRedis(() => 0);
    source.strings.set("linkdish:library:v1:rev:u1", "100");
    source.strings.set("linkdish:library:v1:item:u1:recipe:a", JSON.stringify({ rev: 50 }));
    source.strings.set("linkdish:library:v1:item:u1:recipe:b", JSON.stringify({ rev: 100 }));
    source.zsets.set(
      "linkdish:library:v1:changes:u1",
      new Map([
        ["recipe:a", 50],
        ["recipe:b", 100]
      ])
    );
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);

    await restoreStoreSnapshot(target.run, snapshot, { apply: true, overwrite: true });

    // A device last synced at 100 still pulls both, and one past 102 resets.
    expect([...(target.zsets.get("linkdish:library:v1:changes:u1") ?? [])]).toEqual([
      ["recipe:a", 101],
      ["recipe:b", 102]
    ]);
    expect(target.strings.get("linkdish:library:v1:rev:u1")).toBe("102");
  });

  it("takes a whole library when a prefix selects part of it", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);

    const result = await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      keyPrefixes: ["linkdish:library:v1:item:u1:recipe:a"],
      overwrite: true
    });

    expect(result.written).toBe(3);
    expect(target.strings.get("linkdish:library:v1:rev:u1")).toBe("2");
    expect(target.zsets.get("linkdish:library:v1:changes:u1")?.get("recipe:a")).toBe(2);
    expect(target.strings.has("linkdish:user:v1:u1")).toBe(false);
  });

  it("stops writing a library once its lock has passed to someone else", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    const lockKey = "linkdish:library:v1:lock:u1";
    let renewals = 0;
    const run: StorePipeline = (commands) => {
      if (commands[0]?.[0] === "EVAL" && commands[0][1]?.includes("pexpire") && ++renewals === 2) {
        // The lease ran out and a push took the lock.
        target.strings.set(lockKey, "push");
      }
      return target.run(commands);
    };

    await expect(
      restoreStoreSnapshot(run, snapshot, {
        apply: true,
        batchSize: 1,
        keyPrefixes: ["linkdish:library:"]
      })
    ).rejects.toThrow(/Lost the library lock/u);
    expect(target.strings.has("linkdish:library:v1:item:u1:recipe:a")).toBe(true);
    expect(target.zsets.has("linkdish:library:v1:changes:u1")).toBe(false);
    expect(target.strings.get(lockKey)).toBe("push");
  });

  it("clears live sets the snapshot has no members for, with overwrite", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    target.sets.set("linkdish:library:v1:live:u1:collection", new Set(["c9"]));
    target.strings.set("linkdish:library:v1:rev:u1", "40");

    await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      keyPrefixes: ["linkdish:library:"],
      overwrite: true
    });

    expect(target.sets.has("linkdish:library:v1:live:u1:collection")).toBe(false);
    // Renumbered above the live counter, so every device pulls the restored library again.
    expect(target.strings.get("linkdish:library:v1:rev:u1")).toBe("41");
    expect(target.zsets.get("linkdish:library:v1:changes:u1")?.get("recipe:a")).toBe(41);
    expect(target.strings.get("linkdish:library:v1:item:u1:recipe:a")).toBe(
      JSON.stringify({ rev: 41 })
    );
  });

  it("does nothing without apply, then fills in only missing keys", async () => {
    const takenMs = Date.parse("2026-10-26T00:00:00.000Z");
    const source = createFakeRedis(() => takenMs);
    seed(source, takenMs);
    const snapshot = parseStoreSnapshot(
      JSON.stringify(await createStoreSnapshot(source.run, { now: () => new Date(takenMs) }))
    );

    const restoredMs = takenMs + 20_000;
    const target = createFakeRedis(() => restoredMs);
    target.strings.set("linkdish:user:v1:u1", "newer");
    target.sets.set("linkdish:household-recipes:v1:h1", new Set(["r3"]));

    const dryRun = await restoreStoreSnapshot(target.run, snapshot, {
      now: () => new Date(restoredMs)
    });
    expect(dryRun).toEqual({ applied: false, expired: 0, kept: 2, replaced: 0, written: 8 });
    expect(target.strings.has("linkdish:household:v1:h1")).toBe(false);

    const applied = await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      now: () => new Date(restoredMs)
    });
    expect(applied.written).toBe(8);
    expect(target.strings.get("linkdish:user:v1:u1")).toBe("newer");
    expect([...(target.sets.get("linkdish:household-recipes:v1:h1") ?? [])]).toEqual(["r3"]);
    expect(target.strings.get("linkdish:household:v1:h1")).toBe(JSON.stringify({ id: "h1" }));
    expect(target.zsets.get("linkdish:library:v1:changes:u1")?.get("recipe:a")).toBe(1);
    // The session keeps what was left of its TTL.
    expect(target.expiries.get("linkdish:session:v1:token")).toBe(restoredMs + 40_000);
  });

  it("leaves a library that is partly there alone, without overwrite", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    target.strings.set("linkdish:library:v1:rev:u1", "7");

    const result = await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      keyPrefixes: ["linkdish:library:"],
      now: () => new Date(0)
    });

    expect(result).toEqual({ applied: true, expired: 0, kept: 3, replaced: 0, written: 0 });
    expect(target.strings.has("linkdish:library:v1:item:u1:recipe:a")).toBe(false);
    expect(target.zsets.has("linkdish:library:v1:changes:u1")).toBe(false);
  });

  it("replaces existing keys with overwrite, limited to a prefix", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 0);
    target.strings.set("linkdish:user:v1:u1", "newer");
    target.sets.set("linkdish:household-recipes:v1:h1", new Set(["r3"]));

    const result = await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      keyPrefixes: ["linkdish:household"],
      now: () => new Date(0),
      overwrite: true
    });

    expect(result).toEqual({ applied: true, expired: 0, kept: 0, replaced: 1, written: 1 });
    expect([...(target.sets.get("linkdish:household-recipes:v1:h1") ?? [])].sort()).toEqual([
      "r1",
      "r2"
    ]);
    expect(target.strings.get("linkdish:user:v1:u1")).toBe("newer");
  });

  it("skips sessions whose TTL ran out since the snapshot", async () => {
    const source = createFakeRedis(() => 0);
    seed(source, 0);
    const snapshot = await createStoreSnapshot(source.run, { now: () => new Date(0) });
    const target = createFakeRedis(() => 120_000);

    const result = await restoreStoreSnapshot(target.run, snapshot, {
      apply: true,
      now: () => new Date(120_000)
    });

    expect(result.expired).toBe(1);
    expect(target.strings.has("linkdish:session:v1:token")).toBe(false);
  });
});

describe("parseStoreSnapshot", () => {
  it("rejects other JSON", () => {
    expect(() => parseStoreSnapshot(JSON.stringify({ entries: [] }))).toThrow(/snapshot/u);
  });
});

describe("createUpstashPipeline", () => {
  it("posts to /pipeline and returns the results", async () => {
    const calls: Array<{ body: unknown; url: string }> = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(init.body as string), url });
      return Promise.resolve(new Response(JSON.stringify([{ result: "OK" }, { result: 1 }])));
    }) as unknown as typeof fetch;

    const run = createUpstashPipeline("https://example.upstash.io/", "token", fetchImpl);

    await expect(
      run([
        ["SET", "a", "b"],
        ["EXISTS", "a"]
      ])
    ).resolves.toEqual(["OK", 1]);
    expect(calls).toEqual([
      {
        body: [
          ["SET", "a", "b"],
          ["EXISTS", "a"]
        ],
        url: "https://example.upstash.io/pipeline"
      }
    ]);
  });

  it("throws when any command failed", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify([{ result: "OK" }, { error: "WRONGTYPE" }]))
      )) as unknown as typeof fetch;

    await expect(
      createUpstashPipeline("https://x", "t", fetchImpl)([["GET", "a"]])
    ).rejects.toThrow(/WRONGTYPE/u);
  });
});

describe("backup encryption", () => {
  it("round-trips with the private key and its passphrase, and fails without it", () => {
    const { privateKeyPem, publicKeyPem } = generateBackupKeyPair("correct horse");
    const envelope = encryptBackup('{"hello":"world"}', publicKeyPem);

    expect(envelope).not.toContain("hello");
    expect(decryptBackup(envelope, privateKeyPem, "correct horse")).toBe('{"hello":"world"}');
    expect(() => decryptBackup(envelope, privateKeyPem, "wrong")).toThrow();

    const tampered = JSON.parse(envelope) as { ciphertext: string };
    tampered.ciphertext = Buffer.from("not the data").toString("base64");
    expect(() => decryptBackup(JSON.stringify(tampered), privateKeyPem, "correct horse")).toThrow();
  });
});
