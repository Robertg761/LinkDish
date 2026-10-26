import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  type LibraryChange,
  libraryChangeSchema,
  type LibraryItemKind,
  MAX_LIBRARY_COLLECTIONS,
  MAX_LIBRARY_PULL_CHANGES,
  MAX_LIBRARY_RECIPES,
  type PullLibraryChangesResponse,
  type PushLibraryChangesResponse
} from "../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../config/env.js";
import {
  getStoreStrings,
  isKeyValueStoreConfigured,
  KeyValueStoreUnavailableError,
  runStoreCommand,
  runStoreEval,
  runStoreTransaction,
  setStoreString
} from "../storage/upstash-store.js";

/*
 * A signed-in account's own cookbook, kept so it follows the account between devices. Every
 * recipe and collection is one item holding the newest copy any device sent (or its tombstone).
 * Each accepted write takes the account's next revision, and the change feed (a sorted set of
 * items scored by the revision they were last written at) lets a device pull only what changed
 * since its cursor. Writes for one account run under a short lock, so revisions are handed out
 * and committed in order and a pull never skips a write that commits late.
 */

export class LibraryError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

const libraryVersion = "v1";
const lockTtlSeconds = 30;
const lockRetryDelaysMs = [25, 75, 150, 300, 600];
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/* Keeps a pull page well under Vercel's 4.5 MB response cap. */
const MAX_PULL_PAGE_CHARS = 2_000_000;
const DELETE_KEYS_CHUNK_SIZE = 500;

const libraryKeys = {
  changes: (userId: string) => `linkdish:library:${libraryVersion}:changes:${userId}`,
  item: (userId: string, kind: LibraryItemKind, itemId: string) =>
    `linkdish:library:${libraryVersion}:item:${userId}:${kind}:${itemId}`,
  live: (userId: string, kind: LibraryItemKind) =>
    `linkdish:library:${libraryVersion}:live:${userId}:${kind}`,
  lock: (userId: string) => `linkdish:library:${libraryVersion}:lock:${userId}`,
  rev: (userId: string) => `linkdish:library:${libraryVersion}:rev:${userId}`
};

const libraryLimits: Record<LibraryItemKind, number> = {
  collection: MAX_LIBRARY_COLLECTIONS,
  recipe: MAX_LIBRARY_RECIPES
};

/* What the change feed and a stored item are keyed by: `<kind>:<id>`. */
const toMember = (kind: LibraryItemKind, itemId: string): string => `${kind}:${itemId}`;

const fromMember = (member: string): { itemId: string; kind: LibraryItemKind } | null => {
  const separator = member.indexOf(":");
  const kind = member.slice(0, separator);
  const itemId = member.slice(separator + 1);

  return separator > 0 && itemId && (kind === "recipe" || kind === "collection")
    ? { itemId, kind }
    : null;
};

/*
 * A stored item: the change as accepted, and the revision it was written at. The change is parsed
 * on read without failing the whole pull, so one record a later contract no longer accepts is
 * skipped (and logged) instead of stopping every device's sync at it.
 */
const storedLibraryItemSchema = z.object({
  change: z.unknown(),
  rev: z.number().int().positive(),
  storedAt: z.string().datetime()
});

const readStoredChange = (value: string | null, key: string): LibraryChange | null => {
  if (!value) {
    return null;
  }

  try {
    const stored = storedLibraryItemSchema.parse(JSON.parse(value) as unknown);
    return libraryChangeSchema.parse(stored.change);
  } catch (error) {
    console.warn("Skipping an unreadable library item.", key, error);
    return null;
  }
};

const ensureLibraryAvailable = (): void => {
  if (!extractorApiEnv.LIBRARY_SYNC_ENABLED) {
    throw new LibraryError("LinkDish cloud sync is not enabled.", 404);
  }

  // Without Upstash the store falls back to process memory, which would lose cookbooks.
  if (extractorApiEnv.NODE_ENV === "production" && !isKeyValueStoreConfigured()) {
    throw new LibraryError("LinkDish cloud sync is not available right now.", 503);
  }
};

const withLibraryLock = async <Value>(
  userId: string,
  operation: () => Promise<Value>
): Promise<Value> => {
  const lockKey = libraryKeys.lock(userId);
  const lockValue = randomBytes(16).toString("base64url");

  for (const retryDelayMs of [0, ...lockRetryDelaysMs]) {
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }

    if (!(await setStoreString(lockKey, lockValue, { nx: true, ttlSeconds: lockTtlSeconds }))) {
      continue;
    }

    try {
      return await operation();
    } finally {
      await runStoreEval(releaseLockScript, [lockKey], [lockValue]).catch((error) => {
        console.warn("Failed to release LinkDish library lock.", error);
      });
    }
  }

  throw new LibraryError("Your cookbook is being updated. Please try again.", 409);
};

/* Applies several writes in one Upstash round trip, failing like the single-command helpers. */
const runStoreWrites = async (commands: string[][]): Promise<void> => {
  if (commands.length === 0) {
    return;
  }

  const results = await runStoreTransaction(commands);
  const failed = results.find((result) => result.error);

  if (failed?.error) {
    throw new KeyValueStoreUnavailableError(failed.error);
  }
};

const toInteger = (value: unknown): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? Math.floor(numeric) : 0;
};

/** The account's changes after `since`, oldest first, one page at a time. */
export const pullLibraryChanges = async (
  userId: string,
  since: string
): Promise<PullLibraryChangesResponse> => {
  ensureLibraryAvailable();

  const [revResult, rangeResult] = await runStoreTransaction([
    ["GET", libraryKeys.rev(userId)],
    [
      "ZRANGEBYSCORE",
      libraryKeys.changes(userId),
      `(${since}`,
      "+inf",
      "WITHSCORES",
      "LIMIT",
      "0",
      String(MAX_LIBRARY_PULL_CHANGES)
    ]
  ]);

  if (revResult?.error || rangeResult?.error) {
    throw new KeyValueStoreUnavailableError(
      revResult?.error ?? rangeResult?.error ?? "Library read failed."
    );
  }

  const currentRev = toInteger(revResult?.result);
  const sinceRev = toInteger(since);

  // A cursor past anything this account has written means the stored library was lost or reset
  // since that device last synced: it starts over and sends everything it holds again.
  if (sinceRev > currentRev) {
    return {
      ...(await pullLibraryChanges(userId, "0")),
      reset: true
    };
  }

  const range: unknown[] = Array.isArray(rangeResult?.result) ? rangeResult.result : [];
  const entries: Array<{ member: string; score: number }> = [];

  for (let index = 0; index + 1 < range.length; index += 2) {
    const member = range[index];

    if (typeof member === "string") {
      entries.push({ member, score: toInteger(range[index + 1]) });
    }
  }

  const keyed = entries.map((entry) => {
    const ref = fromMember(entry.member);
    return { ...entry, key: ref ? libraryKeys.item(userId, ref.kind, ref.itemId) : null };
  });
  const itemKeys = keyed.flatMap((entry) => (entry.key ? [entry.key] : []));
  const values = await getStoreStrings(itemKeys);
  const valueByKey = new Map(itemKeys.map((key, index) => [key, values[index] ?? null]));
  const changes: LibraryChange[] = [];
  let cursor = sinceRev;
  let pageChars = 0;
  let truncated = false;

  for (const entry of keyed) {
    const change = entry.key
      ? readStoredChange(valueByKey.get(entry.key) ?? null, entry.key)
      : null;
    const changeChars = change ? JSON.stringify(change).length : 0;

    if (changes.length > 0 && pageChars + changeChars > MAX_PULL_PAGE_CHARS) {
      truncated = true;
      break;
    }

    if (change) {
      changes.push(change);
      pageChars += changeChars;
    }

    cursor = Math.max(cursor, entry.score);
  }

  return {
    changes,
    cursor: String(cursor),
    hasMore: truncated || entries.length === MAX_LIBRARY_PULL_CHANGES
  };
};

const issueMessage = (error: z.ZodError): string =>
  error.issues[0]?.message ?? "This library item is not valid.";

const isSameChange = (left: LibraryChange, right: LibraryChange): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Stores the changes a device sends. Each one is kept only when it is at least as new as the copy
 * already stored and, when it says which copy it was merged with, that copy is the one stored;
 * otherwise the stored copy comes back in `newer` for the device to merge. Invalid
 * changes, and new items past the library limits, are turned away on their own.
 */
export const pushLibraryChanges = async (
  userId: string,
  rawChanges: readonly unknown[]
): Promise<PushLibraryChangesResponse> => {
  ensureLibraryAvailable();

  const rejected: PushLibraryChangesResponse["rejected"] = [];
  const candidates = new Map<
    string,
    { baseUpdatedAt: string | null | undefined; change: LibraryChange; index: number }
  >();

  rawChanges.forEach((rawChange, index) => {
    const parsed = libraryChangeSchema.safeParse(rawChange);

    if (!parsed.success) {
      const ref = (rawChange ?? {}) as { id?: unknown; kind?: unknown };
      rejected.push({
        index,
        ...(ref.kind === "recipe" || ref.kind === "collection" ? { kind: ref.kind } : {}),
        ...(typeof ref.id === "string" ? { id: ref.id.slice(0, 200) } : {}),
        message: issueMessage(parsed.error),
        reason: "invalid"
      });
      return;
    }

    const { baseUpdatedAt, ...change } = parsed.data;
    const member = toMember(change.kind, change.id);
    const previous = candidates.get(member);

    // The same item twice in one batch: only its newest copy counts.
    if (!previous || Date.parse(change.updatedAt) >= Date.parse(previous.change.updatedAt)) {
      candidates.set(member, { baseUpdatedAt, change, index });
    }
  });

  if (candidates.size === 0) {
    return { accepted: [], newer: [], rejected };
  }

  return withLibraryLock(userId, async () => {
    const pending = [...candidates.values()].sort((left, right) => left.index - right.index);
    const keys = pending.map(({ change }) => libraryKeys.item(userId, change.kind, change.id));
    const [storedValues, liveCountResults] = await Promise.all([
      getStoreStrings(keys),
      runStoreTransaction([
        ["SCARD", libraryKeys.live(userId, "recipe")],
        ["SCARD", libraryKeys.live(userId, "collection")]
      ])
    ]);
    const liveCounts: Record<LibraryItemKind, number> = {
      collection: toInteger(liveCountResults[1]?.result),
      recipe: toInteger(liveCountResults[0]?.result)
    };
    const accepted: LibraryChange[] = [];
    const newer: LibraryChange[] = [];
    const unchanged: LibraryChange[] = [];

    pending.forEach(({ baseUpdatedAt, change, index }, position) => {
      const key = keys[position] ?? "";
      const stored = readStoredChange(storedValues[position] ?? null, key);

      if (stored && Date.parse(stored.updatedAt) > Date.parse(change.updatedAt)) {
        newer.push(stored);
        return;
      }

      // A device sending again what is already stored (a retry after a lost answer).
      if (stored && isSameChange(stored, change)) {
        unchanged.push(change);
        return;
      }

      // The device merged its change with an older copy than the one stored (another device wrote
      // in between): it gets the stored copy to merge first instead of overwriting it unseen.
      if (
        stored &&
        baseUpdatedAt !== undefined &&
        (baseUpdatedAt === null || Date.parse(baseUpdatedAt) !== Date.parse(stored.updatedAt))
      ) {
        newer.push(stored);
        return;
      }

      const wasLive = Boolean(stored && !stored.deleted);
      const isLive = !change.deleted;

      if (isLive && !wasLive) {
        if (liveCounts[change.kind] >= libraryLimits[change.kind]) {
          rejected.push({
            id: change.id,
            index,
            kind: change.kind,
            message:
              change.kind === "recipe"
                ? `Cloud cookbooks hold up to ${MAX_LIBRARY_RECIPES} recipes.`
                : `Cloud cookbooks hold up to ${MAX_LIBRARY_COLLECTIONS} collections.`,
            reason: "limit_reached"
          });
          return;
        }

        liveCounts[change.kind] += 1;
      } else if (!isLive && wasLive) {
        liveCounts[change.kind] -= 1;
      }

      accepted.push(change);
    });

    if (accepted.length > 0) {
      const lastRev = toInteger(
        (await runStoreCommand(["INCRBY", libraryKeys.rev(userId), String(accepted.length)])).result
      );
      const firstRev = lastRev - accepted.length + 1;
      const storedAt = new Date().toISOString();

      await runStoreWrites(
        accepted.flatMap((change, offset) => {
          const rev = firstRev + offset;
          const member = toMember(change.kind, change.id);

          return [
            [
              "SET",
              libraryKeys.item(userId, change.kind, change.id),
              JSON.stringify({ change, rev, storedAt })
            ],
            ["ZADD", libraryKeys.changes(userId), String(rev), member],
            change.deleted
              ? ["SREM", libraryKeys.live(userId, change.kind), change.id]
              : ["SADD", libraryKeys.live(userId, change.kind), change.id]
          ];
        })
      );
    }

    return {
      accepted: [...accepted, ...unchanged].map((change) => ({ id: change.id, kind: change.kind })),
      newer,
      rejected: rejected.sort((left, right) => left.index - right.index)
    };
  });
};

/** Removes everything stored for the account's library (account deletion). */
export const deleteLibraryForUser = async (userId: string): Promise<void> => {
  await withLibraryLock(userId, async () => {
    const result = await runStoreCommand(["ZRANGE", libraryKeys.changes(userId), "0", "-1"]);
    const itemKeys = (Array.isArray(result.result) ? result.result : []).flatMap((member) => {
      const ref = typeof member === "string" ? fromMember(member) : null;
      return ref ? [libraryKeys.item(userId, ref.kind, ref.itemId)] : [];
    });

    for (let start = 0; start < itemKeys.length; start += DELETE_KEYS_CHUNK_SIZE) {
      await runStoreCommand(["DEL", ...itemKeys.slice(start, start + DELETE_KEYS_CHUNK_SIZE)]);
    }

    await runStoreCommand([
      "DEL",
      libraryKeys.changes(userId),
      libraryKeys.rev(userId),
      libraryKeys.live(userId, "recipe"),
      libraryKeys.live(userId, "collection")
    ]);
  });
};
