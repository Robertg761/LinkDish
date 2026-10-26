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
  /* When the key expires (ISO), for families that expire; from the TTL at the time it was read. */
  expiresAt?: string;
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
  /* Reads of one library before taking it as it stands (see readLibrary). */
  libraryAttempts?: number;
  libraryRetryDelayMs?: number;
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
  readAtMs: number,
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
      entry.expiresAt = new Date(readAtMs + pttlMs).toISOString();
    }

    entries.push(entry);
  }

  return entries;
};

const libraryKeyPattern = /^linkdish:library:([^:]+):(?:item|live|changes|rev):([^:]+)/u;

/*
 * A synced library is copied as one unit: its change feed, the items the feed names, the live
 * sets and the revision counter, so a restore never pairs an item with a feed score or counter
 * from another moment (pulls would then reset or skip changes). A push bumps the counter first
 * and then writes its items, feed and live sets in one transaction, so a read is coherent when
 * the counter is the same before and after it, equals the feed's top score, and every item
 * carries the revision the feed gives it. Otherwise it is read again; a library that keeps
 * changing for every attempt is taken as last read.
 */
const readLibrary = async (
  run: StorePipeline,
  version: string,
  userId: string,
  attempts: number,
  retryDelayMs: number
): Promise<StoreSnapshotEntry[]> => {
  const prefix = `linkdish:library:${version}`;
  const revKey = `${prefix}:rev:${userId}`;
  const changesKey = `${prefix}:changes:${userId}`;
  const liveKeys = ["recipe", "collection"].map((kind) => `${prefix}:live:${userId}:${kind}`);
  let entries: StoreSnapshotEntry[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [revBefore, changesResult] = await run([
      ["GET", revKey],
      ["ZRANGE", changesKey, "0", "-1", "WITHSCORES"]
    ]);
    const changes = toZsetPairs(changesResult);
    const itemKeys = changes.map(([member]) => `${prefix}:item:${userId}:${member}`);
    const results = await run([
      ...(itemKeys.length > 0 ? [["MGET", ...itemKeys]] : []),
      ...liveKeys.map((key) => ["SMEMBERS", key]),
      ["GET", revKey]
    ]);
    const items = itemKeys.length > 0 ? (results[0] as unknown[]) : [];
    const [recipeLive, collectionLive, revAfter] = results.slice(itemKeys.length > 0 ? 1 : 0);
    const topScore = changes.reduce((top, [, score]) => Math.max(top, score), 0);
    const itemsMatch = changes.every(([, score], index) => {
      const value = Array.isArray(items) ? items[index] : null;

      try {
        return typeof value === "string" && (JSON.parse(value) as { rev?: unknown }).rev === score;
      } catch {
        return false;
      }
    });

    entries = [
      ...(typeof revBefore === "string"
        ? [{ key: revKey, type: "string" as const, value: revBefore }]
        : []),
      ...(changes.length > 0 ? [{ key: changesKey, type: "zset" as const, value: changes }] : []),
      ...changes.flatMap((_, index) => {
        const value = Array.isArray(items) ? items[index] : null;
        return typeof value === "string"
          ? [{ key: itemKeys[index] as string, type: "string" as const, value }]
          : [];
      }),
      ...[recipeLive, collectionLive].flatMap((members, index) =>
        Array.isArray(members) && members.length > 0
          ? [
              {
                key: liveKeys[index] as string,
                type: "set" as const,
                value: members.map(String).sort()
              }
            ]
          : []
      )
    ];

    const coherent =
      revBefore === revAfter &&
      (changes.length === 0 || Number(revBefore) === topScore) &&
      itemsMatch;

    if (coherent) {
      break;
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return entries;
};

export const createStoreSnapshot = async (
  run: StorePipeline,
  {
    batchSize = 200,
    libraryAttempts = 5,
    libraryRetryDelayMs = 250,
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
  // version -> user ids; any library key found by the scan stands for the whole library.
  const libraries = new Map<string, Set<string>>();

  for (const key of keys) {
    const family = findBackedUpKeyFamily(key);
    const library = family?.name.startsWith("library-") ? libraryKeyPattern.exec(key) : null;

    if (library) {
      const [, version = "", userId = ""] = library;
      libraries.set(version, (libraries.get(version) ?? new Set()).add(userId));
      continue;
    }

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
    entries.push(...(await readBatch(run, now().getTime(), batch)));
  }

  for (const [version, userIds] of libraries) {
    for (const userId of [...userIds].sort()) {
      entries.push(
        ...(await readLibrary(run, version, userId, libraryAttempts, libraryRetryDelayMs))
      );
    }
  }

  entries.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

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
  /* Existing keys left alone, with the rest of a library that is partly there (no overwrite). */
  kept: number;
  /* Existing keys replaced (overwrite). */
  replaced: number;
  /* Keys that did not exist and are written. */
  written: number;
}

/*
 * Without overwrite the key was missing a moment ago, so strings and sorted-set members use NX
 * and sets are added to rather than cleared: a write the live API makes in between is never lost.
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
    [
      "ZADD",
      entry.key,
      // NX: a member the live API scored in between keeps its newer score.
      ...(overwrite ? [] : ["NX"]),
      ...pairs.flatMap(([member, score]) => [String(score), member])
    ],
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
  const nowMs = now().getTime();
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

    if (entry.expiresAt == null) {
      candidates.push({ entry, pttlMs: null });
      continue;
    }

    const remainingMs = Date.parse(entry.expiresAt) - nowMs;

    if (remainingMs <= 0) {
      result.expired += 1;
      continue;
    }

    candidates.push({ entry, pttlMs: remainingMs });
  }

  const present = new Set<string>();

  for (const batch of chunk(candidates, batchSize)) {
    const exists = await run(batch.map(({ entry }) => ["EXISTS", entry.key]));
    batch.forEach(({ entry }, index) => {
      if (Number(exists[index]) > 0) {
        present.add(entry.key);
      }
    });
  }

  // A synced library is restored whole or not at all, so it never mixes keys from two moments
  // (see readLibrary): without overwrite, one live key keeps the whole library as it is.
  const libraryOf = (key: string): string | null => {
    const match = libraryKeyPattern.exec(key);
    return match ? `${match[1]}:${match[2]}` : null;
  };
  const presentLibraries = new Set(
    [...present].flatMap((key) => {
      const library = libraryOf(key);
      return library ? [library] : [];
    })
  );

  for (const batch of chunk(candidates, batchSize)) {
    const writes: string[][] = [];

    for (const { entry, pttlMs } of batch) {
      const isPresent = present.has(entry.key);
      const library = libraryOf(entry.key);

      if (!overwrite && (isPresent || (library != null && presentLibraries.has(library)))) {
        result.kept += 1;
        continue;
      }

      if (isPresent) {
        result.replaced += 1;
      } else {
        result.written += 1;
      }

      writes.push(...buildWriteCommands(entry, pttlMs, overwrite));
    }

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
