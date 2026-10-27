import { randomBytes } from "node:crypto";

import {
  libraryItemKinds,
  libraryKeysFor,
  releaseLibraryLockScript
} from "../library/library-keys.js";

import {
  type BackedUpKeyFamily,
  type BackupValueType,
  backedUpKeyFamilies,
  findBackedUpKeyFamily,
  getStoreKeySegment,
  storeKeySegments
} from "./store-key-families.js";

import type { LibraryItemKind } from "../../../../../packages/api-contracts/src/index.js";

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
  /* Synced libraries still changing on every read, so taken as last read (see readLibrary). */
  incoherentLibraries?: number;
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
type LibraryKeys = ReturnType<typeof libraryKeysFor>;

/* A feed member is `<kind>:<id>`. */
const libraryItemKey = (keys: LibraryKeys, userId: string, member: string): string => {
  const separator = member.indexOf(":");
  return keys.item(
    userId,
    member.slice(0, separator) as LibraryItemKind,
    member.slice(separator + 1)
  );
};

const readLibrary = async (
  run: StorePipeline,
  version: string,
  userId: string,
  options: { attempts: number; batchSize: number; retryDelayMs: number }
): Promise<{ coherent: boolean; entries: StoreSnapshotEntry[] }> => {
  const keys = libraryKeysFor(version);
  const revKey = keys.rev(userId);
  const changesKey = keys.changes(userId);
  const liveKeys = libraryItemKinds.map((kind) => keys.live(userId, kind));
  let entries: StoreSnapshotEntry[] = [];

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const [revBefore, changesResult] = await run([
      ["GET", revKey],
      ["ZRANGE", changesKey, "0", "-1", "WITHSCORES"]
    ]);
    const changes = toZsetPairs(changesResult);
    const itemKeys = changes.map(([member]) => libraryItemKey(keys, userId, member));
    // In batches: a library at its limits holds thousands of full recipes.
    const items: unknown[] = [];

    for (const batch of chunk(itemKeys, options.batchSize)) {
      const [values] = await run([["MGET", ...batch]]);
      items.push(...(Array.isArray(values) ? (values as unknown[]) : batch.map(() => null)));
    }

    const [recipeLive, collectionLive, revAfter] = await run([
      ...liveKeys.map((key) => ["SMEMBERS", key]),
      ["GET", revKey]
    ]);
    const topScore = changes.reduce((top, [, score]) => Math.max(top, score), 0);
    const itemsMatch = changes.every(([, score], index) => {
      const value = items[index];

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
        const value = items[index];
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
      return { coherent, entries };
    }

    if (attempt < options.attempts) {
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }

  return { coherent: false, entries };
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
  let incoherentLibraries = 0;

  for (const batch of chunk(toRead, batchSize)) {
    entries.push(...(await readBatch(run, now().getTime(), batch)));
  }

  for (const [version, userIds] of libraries) {
    for (const userId of [...userIds].sort()) {
      const library = await readLibrary(run, version, userId, {
        attempts: libraryAttempts,
        batchSize,
        retryDelayMs: libraryRetryDelayMs
      });
      entries.push(...library.entries);
      incoherentLibraries += library.coherent ? 0 : 1;
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
    incoherentLibraries,
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
  /* Only keys starting with one of these prefixes; a synced library is taken whole if any of it is. */
  keyPrefixes?: string[];
  /* Tries at a synced library's lock while the API holds it. */
  lockAttempts?: number;
  lockRetryDelayMs?: number;
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
  /* Keys of accounts deleted since the snapshot, left out so they stay deleted. */
  ofDeletedAccounts: number;
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

/* Extends the lock while it still holds our token; 0 once another holder has it. */
const renewLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const restoreLockMs = 120_000;

interface HeldLock {
  release: () => Promise<void>;
  /* Before every write: a long restore can outlast one lease, and a write after the lock has
   * passed to someone else would mix the two. Throws once it has. */
  renew: () => Promise<void>;
}

/* The same lock the API takes (SET NX with a token), tried a few times while the API holds it. */
const takeLock = async (
  run: StorePipeline,
  key: string,
  what: string,
  attempts: number,
  retryDelayMs: number
): Promise<HeldLock> => {
  const token = randomBytes(16).toString("base64url");

  for (let attempt = 1; ; attempt += 1) {
    const [acquired] = await run([["SET", key, token, "NX", "PX", String(restoreLockMs)]]);

    if (acquired === "OK") {
      break;
    }

    if (attempt >= attempts) {
      throw new Error(
        `${what[0]?.toUpperCase() ?? ""}${what.slice(1)} stayed locked; try the restore again.`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  return {
    release: async () => {
      await run([["EVAL", releaseLibraryLockScript, "1", key, token]]);
    },
    renew: async () => {
      const [renewed] = await run([
        ["EVAL", renewLockScript, "1", key, token, String(restoreLockMs)]
      ]);

      if (Number(renewed) !== 1) {
        throw new Error(
          `Lost the lock on ${what} part-way through; run the restore again with --overwrite.`
        );
      }
    }
  };
};

/* The snapshot's feed members that it also holds the item of, oldest first. */
const restorableMembers = (
  entries: StoreSnapshotEntry[],
  keys: LibraryKeys,
  userId: string
): string[] => {
  const feed = entries.find((entry) => entry.type === "zset");
  const itemKeys = new Set(entries.map((entry) => entry.key));

  return [...(feed ? (feed.value as Array<[string, number]>) : [])]
    .sort((left, right) => left[1] - right[1])
    .map(([member]) => member)
    .filter((member) => itemKeys.has(libraryItemKey(keys, userId, member)));
};

/*
 * Replacing a library that devices already sync from. Devices hold their own copies, so the
 * restore merges rather than removes: the snapshot's items replace the live ones, and items only
 * the live library has (added since the snapshot) stay, as they are and still live if they were.
 * The merged feed is renumbered above both counters (snapshot items first, in their order,
 * then the kept ones; each item's stored rev to match) and the counter continues from there, so
 * every device pulls the whole library again as new changes, whatever cursor it holds,
 * including one that read the old feed while it was being replaced.
 */
const mergeLibraryForOverwrite = (
  entries: StoreSnapshotEntry[],
  current: {
    /* Live items the snapshot does not restore, in feed order. */
    kept: Map<string, string>;
    live: Record<LibraryItemKind, string[]>;
    rev: number;
  },
  keys: LibraryKeys,
  userId: string
): StoreSnapshotEntry[] => {
  const snapshotMembers = restorableMembers(entries, keys, userId);
  const keptMembers = [...current.kept.keys()];
  /*
   * Above both counters: devices may hold cursors from the live library or from the one the
   * snapshot was taken of (after a rollback the live counter can be the lower one), and a
   * device whose cursor is not below a change never pulls it.
   */
  const floor = Math.max(
    current.rev,
    Number(entries.find((entry) => entry.key === keys.rev(userId))?.value) || 0
  );
  const newRevs = new Map(
    [...snapshotMembers, ...keptMembers].map((member, index) => [member, floor + index + 1])
  );
  const withRev = (value: string, rev: number): string => {
    try {
      return JSON.stringify({ ...(JSON.parse(value) as object), rev });
    } catch {
      return value;
    }
  };
  const merged: StoreSnapshotEntry[] = [];

  for (const entry of entries) {
    const member = /:item:[^:]+:(.+)$/u.exec(entry.key)?.[1];
    const rev = member ? newRevs.get(member) : undefined;

    if (rev != null && typeof entry.value === "string") {
      merged.push({ ...entry, value: withRev(entry.value, rev) });
    } else if (entry.type === "string" && !entry.key.includes(":rev:")) {
      merged.push(entry);
    }
  }

  for (const [member, value] of current.kept) {
    merged.push({
      key: libraryItemKey(keys, userId, member),
      type: "string",
      value: withRev(value, newRevs.get(member) as number)
    });
  }

  for (const kind of libraryItemKinds) {
    const key = keys.live(userId, kind);
    const snapshotLive = entries.find((entry) => entry.key === key);
    const keptLive = current.live[kind].filter((id) => current.kept.has(`${kind}:${id}`));
    const members = [
      ...new Set([...((snapshotLive?.value as string[] | undefined) ?? []), ...keptLive])
    ].sort();

    if (members.length > 0) {
      merged.push({ key, type: "set", value: members });
    }
  }

  if (floor + newRevs.size > 0) {
    merged.push({ key: keys.rev(userId), type: "string", value: String(floor + newRevs.size) });
  }

  if (newRevs.size > 0) {
    merged.push({
      key: keys.changes(userId),
      type: "zset",
      value: [...newRevs].map(([member, rev]): [string, number] => [member, rev])
    });
  }

  return merged;
};

/*
 * Restores one synced library whole, under the library service's own lock so no push or account
 * deletion runs in between. Without overwrite a library that has any of its counter, feed or
 * live sets is left as it is. Items go first and the feed last, so a pull during the restore
 * never sees feed entries without their items.
 */
const restoreLibrary = async (
  run: StorePipeline,
  version: string,
  userId: string,
  entries: StoreSnapshotEntry[],
  options: {
    apply: boolean;
    batchSize: number;
    lockAttempts: number;
    lockRetryDelayMs: number;
    overwrite: boolean;
    /* Renews the lock on the library's account, if the caller holds one. */
    holdAccount: () => Promise<void>;
  }
): Promise<{ kept: number; replaced: number; written: number }> => {
  const keys = libraryKeysFor(version);
  const liveKeys = libraryItemKinds.map((kind) => keys.live(userId, kind));
  const coreKeys = [keys.rev(userId), keys.changes(userId), ...liveKeys];
  const lock = options.apply
    ? await takeLock(
        run,
        keys.lock(userId),
        `the library of user ${userId}`,
        options.lockAttempts,
        options.lockRetryDelayMs
      )
    : null;
  const holdLock = async (): Promise<void> => {
    await options.holdAccount();
    await lock?.renew();
  };

  try {
    const coreExists = await run(coreKeys.map((key) => ["EXISTS", key]));
    const libraryPresent = coreExists.some((exists) => Number(exists) > 0);

    if (libraryPresent && !options.overwrite) {
      return { kept: entries.length, replaced: 0, written: 0 };
    }

    const exists = await run(entries.map((entry) => ["EXISTS", entry.key]));
    const replaced = exists.filter((value) => Number(value) > 0).length;

    if (options.apply) {
      const rank = (entry: StoreSnapshotEntry): number =>
        entry.key.includes(":item:")
          ? 0
          : entry.key.includes(":live:")
            ? 1
            : entry.key.includes(":rev:")
              ? 2
              : 3;
      let restored = entries;

      if (options.overwrite) {
        const [currentRev, currentFeed, ...currentLive] = await run([
          ["GET", keys.rev(userId)],
          ["ZRANGE", keys.changes(userId), "0", "-1", "WITHSCORES"],
          ...liveKeys.map((key) => ["SMEMBERS", key])
        ]);
        const restoring = new Set(restorableMembers(entries, keys, userId));
        const keptMembers = toZsetPairs(currentFeed)
          .map(([member]) => member)
          .filter((member) => !restoring.has(member));
        const kept = new Map<string, string>();

        for (const batch of chunk(keptMembers, options.batchSize)) {
          const [values] = await run([
            ["MGET", ...batch.map((member) => libraryItemKey(keys, userId, member))]
          ]);
          batch.forEach((member, index) => {
            const value: unknown = Array.isArray(values) ? values[index] : null;
            if (typeof value === "string") {
              kept.set(member, value);
            }
          });
        }

        restored = mergeLibraryForOverwrite(
          entries,
          {
            kept,
            live: Object.fromEntries(
              libraryItemKinds.map((kind, index) => {
                const members = currentLive[index];
                return [kind, Array.isArray(members) ? members.map(String) : []];
              })
            ) as Record<LibraryItemKind, string[]>,
            rev: Number(currentRev) || 0
          },
          keys,
          userId
        );
      }

      /*
       * With overwrite nothing is deleted up front: the live feed and sets are what a retry
       * after a failure finds the kept items through. Each set and the feed are built under a
       * scratch key and swapped in with one RENAME, the feed last.
       */
      const swapIn = (entry: StoreSnapshotEntry): string[][] => {
        const scratch = `linkdish:library:${version}:restoring:${userId}`;
        const fill =
          entry.type === "set"
            ? ["SADD", scratch, ...(entry.value as string[])]
            : [
                "ZADD",
                scratch,
                ...(entry.value as Array<[string, number]>).flatMap(([member, score]) => [
                  String(score),
                  member
                ])
              ];
        return [["DEL", scratch], fill, ["RENAME", scratch, entry.key]];
      };
      const ordered = [...restored].sort((left, right) => rank(left) - rank(right));

      for (const batch of chunk(ordered, options.batchSize)) {
        await holdLock();
        await run(
          batch.flatMap((entry) =>
            options.overwrite && entry.type !== "string"
              ? swapIn(entry)
              : buildWriteCommands(entry, null, true)
          )
        );
      }

      // A live set or feed that neither the snapshot nor a kept item fills.
      const emptied = coreKeys.filter((key) => !restored.some((entry) => entry.key === key));

      if (options.overwrite && emptied.length > 0) {
        await holdLock();
        await run([["DEL", ...emptied]]);
      }
    }

    return { kept: 0, replaced, written: entries.length - replaced };
  } finally {
    await lock?.release();
  }
};

/*
 * Held by deleteAccountAndHouseholdAccess (households/household-service.ts) while it deletes an
 * account, so a restore of that account's keys runs before the deletion or not at all.
 */
const accountLockKey = (userId: string): string => `linkdish:household-lock:v1:user:${userId}`;

/* The account an entry belongs to: by a key segment, or what a lookup or session points at. */
const ownerOf = (entry: StoreSnapshotEntry, userIds: Set<string>): string | null => {
  const fromKey = entry.key.split(":").find((segment) => userIds.has(segment));
  if (fromKey) return fromKey;

  const family = findBackedUpKeyFamily(entry.key)?.name;
  if (typeof entry.value !== "string") return null;
  if ((family === "user-by-email" || family === "identity") && userIds.has(entry.value)) {
    return entry.value;
  }

  if (family === "session") {
    try {
      const { userId } = JSON.parse(entry.value) as { userId?: unknown };
      return typeof userId === "string" && userIds.has(userId) ? userId : null;
    } catch {
      return null;
    }
  }

  return null;
};

const parseRecord = (entry: StoreSnapshotEntry): Record<string, unknown> | null => {
  try {
    const value: unknown = typeof entry.value === "string" ? JSON.parse(entry.value) : null;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/*
 * What a deleted account shared with a Family household goes when it is deleted: a household it
 * owned is dissolved (with its recipes, list, invites), and a recipe it shared is removed, as is
 * its membership. A restore leaves all of that out rather than show it to the others again.
 */
const withoutDeletedMembers = <Candidate extends { entry: StoreSnapshotEntry }>(
  candidates: Candidate[],
  deletedUserIds: Set<string>
): Candidate[] => {
  if (deletedUserIds.size === 0) return candidates;

  const family = (entry: StoreSnapshotEntry) => findBackedUpKeyFamily(entry.key)?.name;
  const households = new Set<string>();
  const recipes = new Set<string>();

  for (const { entry } of candidates) {
    const record = parseRecord(entry);
    const owner = record?.ownerUserId;
    if (typeof owner !== "string" || !deletedUserIds.has(owner) || typeof record?.id !== "string") {
      continue;
    }
    if (family(entry) === "household") households.add(record.id);
    if (family(entry) === "household-recipe") recipes.add(record.id);
  }

  return candidates.flatMap((candidate) => {
    const { entry } = candidate;
    const record = parseRecord(entry);
    const name = family(entry);

    if (
      entry.key.split(":").some((segment) => households.has(segment)) ||
      (typeof record?.householdId === "string" && households.has(record.householdId)) ||
      (name === "household-recipe" && typeof record?.id === "string" && recipes.has(record.id)) ||
      (name === "household-by-user" &&
        typeof entry.value === "string" &&
        households.has(entry.value)) ||
      (name === "household-recipe-by-source" &&
        typeof entry.value === "string" &&
        recipes.has(entry.value))
    ) {
      return [];
    }

    if (name === "household-recipes") {
      const members = (entry.value as string[]).filter((member) => !recipes.has(member));
      return members.length > 0 ? [{ ...candidate, entry: { ...entry, value: members } }] : [];
    }

    if (name === "household" && record && Array.isArray(record.memberUserIds)) {
      const memberJoinedAt = Object.fromEntries(
        Object.entries((record.memberJoinedAt as Record<string, unknown> | undefined) ?? {}).filter(
          ([userId]) => !deletedUserIds.has(userId)
        )
      );
      const value = JSON.stringify({
        ...record,
        memberUserIds: (record.memberUserIds as unknown[]).filter(
          (userId) => typeof userId !== "string" || !deletedUserIds.has(userId)
        ),
        ...(record.memberJoinedAt ? { memberJoinedAt } : {})
      });
      return [{ ...candidate, entry: { ...entry, value } }];
    }

    return [candidate];
  });
};

const isDeletedUserRecord = (value: unknown): boolean => {
  try {
    return (
      typeof value === "string" && Boolean((JSON.parse(value) as { deletedAt?: unknown }).deletedAt)
    );
  } catch {
    return false;
  }
};

export const restoreStoreSnapshot = async (
  run: StorePipeline,
  snapshot: StoreSnapshot,
  {
    apply = false,
    batchSize = 100,
    keyPrefixes = [],
    lockAttempts = 20,
    lockRetryDelayMs = 500,
    now = () => new Date(),
    overwrite = false
  }: RestoreStoreSnapshotOptions = {}
): Promise<RestoreStoreSnapshotResult> => {
  const nowMs = now().getTime();
  const result: RestoreStoreSnapshotResult = {
    applied: apply,
    expired: 0,
    kept: 0,
    ofDeletedAccounts: 0,
    replaced: 0,
    written: 0
  };
  type Candidate = { entry: StoreSnapshotEntry; pttlMs: number | null };
  const candidates: Candidate[] = [];

  const libraryIdOf = (key: string): string | null => {
    const match = libraryKeyPattern.exec(key);
    return match ? `${match[1]}:${match[2]}` : null;
  };
  const matchesPrefix = (key: string): boolean =>
    keyPrefixes.length === 0 || keyPrefixes.some((prefix) => key.startsWith(prefix));
  // Restoring part of a library would pair it with the rest from another moment.
  const selectedLibraries = new Set(
    snapshot.entries.flatMap((entry) => {
      const id = libraryIdOf(entry.key);
      return id && matchesPrefix(entry.key) ? [id] : [];
    })
  );

  for (const entry of snapshot.entries) {
    const libraryId = libraryIdOf(entry.key);

    if (libraryId ? !selectedLibraries.has(libraryId) : !matchesPrefix(entry.key)) {
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

  const restoreEntries = async (
    group: Candidate[],
    holdAccount: () => Promise<void>
  ): Promise<void> => {
    const libraries = new Map<string, StoreSnapshotEntry[]>();
    const others: Candidate[] = [];

    for (const candidate of group) {
      const libraryId = libraryIdOf(candidate.entry.key);

      if (libraryId) {
        const library = libraries.get(libraryId);
        if (library) library.push(candidate.entry);
        else libraries.set(libraryId, [candidate.entry]);
      } else {
        others.push(candidate);
      }
    }

    for (const batch of chunk(others, batchSize)) {
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
        await holdAccount();
        await run(writes);
      }
    }

    for (const [id, entries] of [...libraries].sort(([left], [right]) => (left < right ? -1 : 1))) {
      const [version = "", userId = ""] = id.split(":");
      const counts = await restoreLibrary(run, version, userId, entries, {
        apply,
        batchSize,
        holdAccount,
        lockAttempts,
        lockRetryDelayMs,
        overwrite
      });
      result.kept += counts.kept;
      result.replaced += counts.replaced;
      result.written += counts.written;
    }
  };

  /*
   * Deleting an account keeps its user record (marked deletedAt) but removes its email lookup,
   * sessions, sign-in identities and library: missing, not lost. So each account's keys are
   * restored under the lock account deletion takes, and only if the account is not deleted.
   */
  const userKeys = new Map<string, string>();

  for (const { key } of snapshot.entries) {
    if (findBackedUpKeyFamily(key)?.name === "user") {
      userKeys.set(key.slice(key.lastIndexOf(":") + 1), key);
    }
  }

  const userIds = new Set(userKeys.keys());
  const deletedUserIds = new Set<string>();

  for (const batch of chunk([...userKeys], batchSize)) {
    const [values] = await run([["MGET", ...batch.map(([, key]) => key)]]);
    batch.forEach(([userId], index) => {
      if (isDeletedUserRecord(Array.isArray(values) ? values[index] : null)) {
        deletedUserIds.add(userId);
      }
    });
  }

  const shared = withoutDeletedMembers(candidates, deletedUserIds);
  result.ofDeletedAccounts += candidates.length - shared.length;
  const byAccount = new Map<string, Candidate[]>();
  const unowned: Candidate[] = [];

  for (const candidate of shared) {
    const owner = ownerOf(candidate.entry, userIds);
    const group = owner ? byAccount.get(owner) : unowned;
    if (group) group.push(candidate);
    else if (owner) byAccount.set(owner, [candidate]);
  }

  await restoreEntries(unowned, () => Promise.resolve());

  for (const [userId, group] of [...byAccount].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const lock = apply
      ? await takeLock(
          run,
          accountLockKey(userId),
          `the account of user ${userId}`,
          lockAttempts,
          lockRetryDelayMs
        )
      : null;

    try {
      const [user] = await run([["GET", userKeys.get(userId) as string]]);

      if (isDeletedUserRecord(user)) {
        result.ofDeletedAccounts += group.length;
        continue;
      }

      await restoreEntries(group, async () => {
        await lock?.renew();
      });
    } finally {
      await lock?.release();
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
