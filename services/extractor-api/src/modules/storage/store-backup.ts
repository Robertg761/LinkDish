import {
  type BackedUpKeyFamily,
  type BackupValueType,
  backedUpKeyFamilies,
  findBackedUpKeyFamily,
  getStoreKeySegment,
  storeKeySegments
} from "./store-key-families.js";

/*
 * Nightly snapshot and restore of the account data in Upstash (users, sessions, identities,
 * households, synced libraries). Talks to Redis through a plain pipeline function so the
 * scripts can hand it the Upstash REST pipeline and tests a fake. Not used by request handlers.
 */

export const STORE_SNAPSHOT_FORMAT = "linkdish-store-snapshot";
export const STORE_SNAPSHOT_VERSION = 1;

/* Runs commands in order and returns each result; throws if any command failed. */
export type StorePipeline = (commands: string[][]) => Promise<unknown[]>;

export interface StoreSnapshotEntry {
  key: string;
  /* Remaining TTL when the snapshot was taken, for families that expire. */
  pttlMs?: number;
  type: BackupValueType;
  value: string | string[] | Array<[member: string, score: number]>;
}

export interface StoreSnapshot {
  createdAt: string;
  entries: StoreSnapshotEntry[];
  /* Entries per family name. */
  families: Record<string, number>;
  format: typeof STORE_SNAPSHOT_FORMAT;
  /* Keys left out, per `linkdish:<segment>:`. */
  skipped: Record<string, number>;
  /* Keys under a segment marked "backup" (or not listed at all) that no family matched. */
  unclassified: Record<string, number>;
  version: typeof STORE_SNAPSHOT_VERSION;
}

export interface CreateStoreSnapshotOptions {
  batchSize?: number;
  maxScanIterations?: number;
  now?: () => Date;
  scanCount?: number;
}

const increment = (counts: Record<string, number>, name: string): void => {
  counts[name] = (counts[name] ?? 0) + 1;
};

const chunk = <Value>(values: Value[], size: number): Value[][] => {
  const chunks: Value[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const scanKeys = async (
  run: StorePipeline,
  scanCount: number,
  maxScanIterations: number
): Promise<string[]> => {
  const keys = new Set<string>();
  let cursor = "0";

  for (let iteration = 0; iteration < maxScanIterations; iteration += 1) {
    const [result] = await run([
      ["SCAN", cursor, "MATCH", "linkdish:*", "COUNT", String(scanCount)]
    ]);
    const payload = Array.isArray(result) ? result : [];
    cursor = String(payload[0] ?? "0");

    for (const key of Array.isArray(payload[1]) ? payload[1] : []) {
      keys.add(String(key));
    }

    if (cursor === "0") {
      return [...keys].sort();
    }
  }

  throw new Error("Key scan did not finish within the iteration limit.");
};

const toZsetPairs = (result: unknown): Array<[string, number]> => {
  const flat = Array.isArray(result) ? result.map(String) : [];
  const pairs: Array<[string, number]> = [];

  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([flat[index] as string, Number(flat[index + 1])]);
  }

  return pairs;
};

/*
 * Strings are read with one MGET per batch; sets and sorted sets need a command per key. A key
 * deleted between the scan and the read comes back empty and is left out.
 */
const readBatch = async (
  run: StorePipeline,
  batch: Array<{ family: BackedUpKeyFamily; key: string }>
): Promise<StoreSnapshotEntry[]> => {
  const stringKeys = batch.filter(({ family }) => family.type === "string");
  const commands: string[][] = [];

  if (stringKeys.length > 0) {
    commands.push(["MGET", ...stringKeys.map(({ key }) => key)]);
  }

  for (const { family, key } of batch) {
    if (family.type === "set") {
      commands.push(["SMEMBERS", key]);
    } else if (family.type === "zset") {
      commands.push(["ZRANGE", key, "0", "-1", "WITHSCORES"]);
    }
  }

  for (const { family, key } of batch) {
    if (family.expires) {
      commands.push(["PTTL", key]);
    }
  }

  const results = await run(commands);
  let cursor = 0;
  const stringValues = stringKeys.length > 0 ? (results[cursor++] as unknown[]) : [];
  const values = new Map<string, StoreSnapshotEntry["value"] | null>();

  stringKeys.forEach(({ key }, index) => {
    const value = Array.isArray(stringValues) ? stringValues[index] : null;
    values.set(key, typeof value === "string" ? value : null);
  });

  for (const { family, key } of batch) {
    if (family.type === "set") {
      const members = results[cursor++];
      values.set(key, Array.isArray(members) ? members.map(String).sort() : []);
    } else if (family.type === "zset") {
      values.set(key, toZsetPairs(results[cursor++]));
    }
  }

  const ttls = new Map<string, number>();

  for (const { family, key } of batch) {
    if (family.expires) {
      ttls.set(key, Number(results[cursor++]));
    }
  }

  const entries: StoreSnapshotEntry[] = [];

  for (const { family, key } of batch) {
    const value = values.get(key);

    if (value == null || (Array.isArray(value) && value.length === 0)) {
      continue;
    }

    const entry: StoreSnapshotEntry = { key, type: family.type, value };
    const pttlMs = ttls.get(key);

    // -1: no TTL, -2: gone since the read.
    if (pttlMs === -2) {
      continue;
    }

    if (pttlMs != null && pttlMs > 0) {
      entry.pttlMs = pttlMs;
    }

    entries.push(entry);
  }

  return entries;
};

export const createStoreSnapshot = async (
  run: StorePipeline,
  {
    batchSize = 200,
    maxScanIterations = 10_000,
    now = () => new Date(),
    scanCount = 1000
  }: CreateStoreSnapshotOptions = {}
): Promise<StoreSnapshot> => {
  const createdAt = now().toISOString();
  const keys = await scanKeys(run, scanCount, maxScanIterations);
  const skipped: Record<string, number> = {};
  const unclassified: Record<string, number> = {};
  const toRead: Array<{ family: BackedUpKeyFamily; key: string }> = [];

  for (const key of keys) {
    const family = findBackedUpKeyFamily(key);

    if (family) {
      toRead.push({ family, key });
      continue;
    }

    const segment = getStoreKeySegment(key);
    const classification = storeKeySegments[segment];

    if (classification === "ephemeral" || classification === "mixed") {
      increment(skipped, segment);
    } else {
      increment(unclassified, segment);
    }
  }

  const entries: StoreSnapshotEntry[] = [];

  for (const batch of chunk(toRead, batchSize)) {
    entries.push(...(await readBatch(run, batch)));
  }

  const families: Record<string, number> = Object.fromEntries(
    backedUpKeyFamilies.map((family) => [family.name, 0])
  );

  for (const entry of entries) {
    increment(families, findBackedUpKeyFamily(entry.key)?.name ?? "unknown");
  }

  return {
    createdAt,
    entries,
    families,
    format: STORE_SNAPSHOT_FORMAT,
    skipped,
    unclassified,
    version: STORE_SNAPSHOT_VERSION
  };
};

export const parseStoreSnapshot = (json: string): StoreSnapshot => {
  const parsed = JSON.parse(json) as Partial<StoreSnapshot>;

  if (parsed.format !== STORE_SNAPSHOT_FORMAT || parsed.version !== STORE_SNAPSHOT_VERSION) {
    throw new Error("Not a LinkDish store snapshot this tool can read.");
  }

  if (!Array.isArray(parsed.entries) || typeof parsed.createdAt !== "string") {
    throw new Error("The snapshot is missing its entries or creation time.");
  }

  return parsed as StoreSnapshot;
};

export interface RestoreStoreSnapshotOptions {
  /* Without it nothing is written: the result says what would be. */
  apply?: boolean;
  batchSize?: number;
  /* Only keys starting with one of these prefixes. */
  keyPrefixes?: string[];
  now?: () => Date;
  /* Replace keys that exist. Without it, existing keys are left as they are. */
  overwrite?: boolean;
}

export interface RestoreStoreSnapshotResult {
  applied: boolean;
  /* Session or invite TTLs that ran out since the snapshot. */
  expired: number;
  /* Existing keys left alone (no overwrite). */
  kept: number;
  /* Existing keys replaced (overwrite). */
  replaced: number;
  /* Keys that did not exist and are written. */
  written: number;
}

/*
 * Without overwrite the key was missing a moment ago, so strings use NX and sets are added to
 * rather than cleared: a write the live API makes in between is never lost.
 */
const buildWriteCommands = (
  entry: StoreSnapshotEntry,
  pttlMs: number | null,
  overwrite: boolean
): string[][] => {
  const ttl = pttlMs == null ? [] : [["PEXPIRE", entry.key, String(pttlMs)]];
  const clear = overwrite ? [["DEL", entry.key]] : [];

  if (entry.type === "string") {
    return [
      [
        "SET",
        entry.key,
        String(entry.value),
        ...(overwrite ? [] : ["NX"]),
        ...(pttlMs == null ? [] : ["PX", String(pttlMs)])
      ]
    ];
  }

  if (entry.type === "set") {
    return [...clear, ["SADD", entry.key, ...(entry.value as string[])], ...ttl];
  }

  const pairs = entry.value as Array<[string, number]>;
  return [
    ...clear,
    ["ZADD", entry.key, ...pairs.flatMap(([member, score]) => [String(score), member])],
    ...ttl
  ];
};

export const restoreStoreSnapshot = async (
  run: StorePipeline,
  snapshot: StoreSnapshot,
  {
    apply = false,
    batchSize = 100,
    keyPrefixes = [],
    now = () => new Date(),
    overwrite = false
  }: RestoreStoreSnapshotOptions = {}
): Promise<RestoreStoreSnapshotResult> => {
  const elapsedMs = Math.max(0, now().getTime() - Date.parse(snapshot.createdAt));
  const result: RestoreStoreSnapshotResult = {
    applied: apply,
    expired: 0,
    kept: 0,
    replaced: 0,
    written: 0
  };
  const candidates: Array<{ entry: StoreSnapshotEntry; pttlMs: number | null }> = [];

  for (const entry of snapshot.entries) {
    if (keyPrefixes.length > 0 && !keyPrefixes.some((prefix) => entry.key.startsWith(prefix))) {
      continue;
    }

    if (entry.pttlMs == null) {
      candidates.push({ entry, pttlMs: null });
      continue;
    }

    const remainingMs = entry.pttlMs - elapsedMs;

    if (remainingMs <= 0) {
      result.expired += 1;
      continue;
    }

    candidates.push({ entry, pttlMs: remainingMs });
  }

  for (const batch of chunk(candidates, batchSize)) {
    const exists = await run(batch.map(({ entry }) => ["EXISTS", entry.key]));
    const writes: string[][] = [];

    batch.forEach(({ entry, pttlMs }, index) => {
      const present = Number(exists[index]) > 0;

      if (present && !overwrite) {
        result.kept += 1;
        return;
      }

      if (present) {
        result.replaced += 1;
      } else {
        result.written += 1;
      }

      writes.push(...buildWriteCommands(entry, pttlMs, overwrite));
    });

    if (apply && writes.length > 0) {
      await run(writes);
    }
  }

  return result;
};

interface UpstashPipelineItem {
  error?: string;
  result?: unknown;
}

/* The Upstash REST `/pipeline` endpoint: commands run in order, not as one transaction. */
export const createUpstashPipeline =
  (url: string, token: string, fetchImpl: typeof fetch = fetch): StorePipeline =>
  async (commands) => {
    if (commands.length === 0) {
      return [];
    }

    const response = await fetchImpl(`${url.replace(/\/+$/u, "")}/pipeline`, {
      body: JSON.stringify(commands),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      throw new Error(`Upstash pipeline failed with ${response.status}.`);
    }

    const body = (await response.json()) as UpstashPipelineItem[] | UpstashPipelineItem;

    if (!Array.isArray(body)) {
      throw new Error(body.error ?? "Upstash pipeline failed.");
    }

    const failed = body.find((item) => item.error);

    if (failed) {
      throw new Error(`Upstash command failed: ${failed.error}`);
    }

    return body.map((item) => item.result);
  };
