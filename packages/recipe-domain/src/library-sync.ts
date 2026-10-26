/**
 * The device side of personal library sync, shared by the web app and Android: how a device
 * tells what changed on it, what changed elsewhere, and merges the two.
 *
 * A device remembers a fingerprint of every item as the cloud last had it (the "base"). An item
 * whose local fingerprint differs from its base changed on the device; a pulled copy whose
 * fingerprint differs from the base changed elsewhere. Fields are compared in groups (a recipe's
 * content, its notes, favorite, tags, ...), so edits to different groups on two devices both
 * survive; when both devices changed the same group, the device merging keeps its own version,
 * except for groups that combine (tags, collections, the cook log).
 *
 * Nothing here does I/O: the apps read and write their own storage and the API through
 * {@link LibrarySyncAdapter}, and {@link runLibrarySync} drives one sync run.
 */

export type LibraryItemKind = "recipe" | "collection";

/** An item's synced fields, as the API carries them (`LibraryRecipe` or `LibraryCollection`). */
export type LibrarySyncPayload = Record<string, unknown>;

/** Group name → hash of that group's fields. */
export type LibraryFingerprint = Record<string, string>;

export interface LibrarySyncGroup {
  name: string;
  keys: readonly string[];
  /**
   * How to settle the group when both sides changed it. Gets each side's fields of the group
   * (absent keys left out) and returns the merged fields. Without it, the local side wins.
   */
  combine?: (local: LibrarySyncPayload, remote: LibrarySyncPayload) => LibrarySyncPayload;
}

/* ------------------------------------------------------------------------------------------------
 * Fingerprints
 * ---------------------------------------------------------------------------------------------- */

/** JSON with object keys sorted (and `undefined` left out), so equal values read the same. */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : stableStringify(entry))).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
};

/** A 53-bit string hash (cyrb53): cheap, and collisions are not a practical concern here. */
export const hashString = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2_654_435_761);
    h2 = Math.imul(h2 ^ code, 1_597_334_677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);

  return (4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)).toString(36);
};

const pickGroup = (payload: LibrarySyncPayload, group: LibrarySyncGroup): LibrarySyncPayload => {
  const picked: LibrarySyncPayload = {};

  for (const key of group.keys) {
    if (payload[key] !== undefined) {
      picked[key] = payload[key];
    }
  }

  return picked;
};

const hashGroup = (payload: LibrarySyncPayload, group: LibrarySyncGroup): string =>
  hashString(stableStringify(pickGroup(payload, group)));

export const fingerprintPayload = (
  payload: LibrarySyncPayload,
  groups: readonly LibrarySyncGroup[]
): LibraryFingerprint =>
  Object.fromEntries(groups.map((group) => [group.name, hashGroup(payload, group)]));

/** The whole fingerprint as one string, to compare or store compactly. */
export const fingerprintKey = (fingerprint: LibraryFingerprint): string =>
  stableStringify(fingerprint);

export const sameFingerprint = (
  left: LibraryFingerprint | null | undefined,
  right: LibraryFingerprint | null | undefined
): boolean => Boolean(left && right && fingerprintKey(left) === fingerprintKey(right));

/* ------------------------------------------------------------------------------------------------
 * Field groups
 * ---------------------------------------------------------------------------------------------- */

const MAX_COOK_LOG_ENTRIES = 100;

const textList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** Both sides' entries, first spelling kept, compared without case. */
const unionText = (local: unknown, remote: unknown): string[] => {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const entry of [...textList(local), ...textList(remote)]) {
    const key = entry.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
};

const withoutEmptyList = (key: string, list: unknown[], limit: number): LibrarySyncPayload =>
  list.length ? { [key]: list.slice(0, limit) } : {};

interface CookLogEntryLike {
  cookedAt: string;
  note?: string | undefined;
}

const cookLogOf = (value: unknown): CookLogEntryLike[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is CookLogEntryLike =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { cookedAt?: unknown }).cookedAt === "string"
      )
    : [];

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const laterDate = (left: unknown, right: unknown): string | undefined => {
  const dates = [left, right].filter((entry): entry is string => typeof entry === "string");
  return dates.sort().at(-1);
};

/**
 * Cooks logged on either device all count: the logs are joined (one entry per cook time), the
 * count is at least what either side counted plus what the other logged on its own, and the last
 * cook is the latest either knows.
 */
const combineCooking = (
  local: LibrarySyncPayload,
  remote: LibrarySyncPayload
): LibrarySyncPayload => {
  const localLog = cookLogOf(local.cookLog);
  const remoteLog = cookLogOf(remote.cookLog);
  const byTime = new Map<string, CookLogEntryLike>();

  for (const entry of [...remoteLog, ...localLog]) {
    byTime.set(entry.cookedAt, { ...byTime.get(entry.cookedAt), ...entry });
  }

  const cookLog = [...byTime.values()]
    .sort((left, right) => (left.cookedAt < right.cookedAt ? -1 : 1))
    .slice(-MAX_COOK_LOG_ENTRIES);
  const localOnly = localLog.filter(
    (entry) => !remoteLog.some((other) => other.cookedAt === entry.cookedAt)
  ).length;
  const timesCooked = Math.max(
    numberOr(local.timesCooked, 0),
    numberOr(remote.timesCooked, 0) + localOnly,
    cookLog.length
  );
  const lastCookedAt = laterDate(local.lastCookedAt, remote.lastCookedAt);

  return {
    ...(cookLog.length ? { cookLog } : {}),
    ...(timesCooked > 0 ? { timesCooked } : {}),
    ...(lastCookedAt ? { lastCookedAt } : {})
  };
};

export const LIBRARY_RECIPE_SYNC_GROUPS: readonly LibrarySyncGroup[] = [
  { keys: ["recipe", "fetchMode", "provenance", "strategy", "warnings"], name: "content" },
  { keys: ["notes"], name: "notes" },
  { keys: ["createdAt", "clonedFromId"], name: "origin" },
  {
    combine: (local, remote) => (local.favorite || remote.favorite ? { favorite: true } : {}),
    keys: ["favorite"],
    name: "favorite"
  },
  {
    combine: (local, remote) => withoutEmptyList("tags", unionText(local.tags, remote.tags), 20),
    keys: ["tags"],
    name: "tags"
  },
  {
    combine: (local, remote) =>
      withoutEmptyList(
        "collectionIds",
        unionText(local.collectionIds, remote.collectionIds),
        Number.POSITIVE_INFINITY
      ),
    keys: ["collectionIds"],
    name: "collections"
  },
  { keys: ["rating"], name: "rating" },
  { combine: combineCooking, keys: ["cookLog", "timesCooked", "lastCookedAt"], name: "cooking" },
  { keys: ["preferredServings"], name: "servings" }
];

export const LIBRARY_COLLECTION_SYNC_GROUPS: readonly LibrarySyncGroup[] = [
  { keys: ["name", "emoji", "description"], name: "details" },
  { keys: ["sortOrder"], name: "order" },
  { keys: ["createdAt"], name: "origin" }
];

export const librarySyncGroupsFor = (kind: LibraryItemKind): readonly LibrarySyncGroup[] =>
  kind === "recipe" ? LIBRARY_RECIPE_SYNC_GROUPS : LIBRARY_COLLECTION_SYNC_GROUPS;

/* ------------------------------------------------------------------------------------------------
 * Merging
 * ---------------------------------------------------------------------------------------------- */

/**
 * The local and remote copies merged group by group against `base` (null: no common version, as
 * on an account's first sync on a device). A group only one side changed takes that side; a group
 * both changed is combined, or keeps the local side.
 */
export const mergeLibraryPayloads = (
  base: LibraryFingerprint | null | undefined,
  local: LibrarySyncPayload,
  remote: LibrarySyncPayload,
  groups: readonly LibrarySyncGroup[]
): LibrarySyncPayload => {
  const merged: LibrarySyncPayload = {};

  for (const group of groups) {
    const localGroup = pickGroup(local, group);
    const remoteGroup = pickGroup(remote, group);
    const localHash = hashString(stableStringify(localGroup));
    const remoteHash = hashString(stableStringify(remoteGroup));
    const baseHash = base?.[group.name];
    const chosen =
      localHash === remoteHash || remoteHash === baseHash
        ? localGroup
        : localHash === baseHash
          ? remoteGroup
          : group.combine
            ? group.combine(localGroup, remoteGroup)
            : localGroup;

    Object.assign(merged, chosen);
  }

  // Keys outside every group (none today) are carried from the local copy.
  const grouped = new Set(groups.flatMap((group) => group.keys));

  for (const [key, value] of Object.entries(local)) {
    if (!grouped.has(key) && value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
};

/* ------------------------------------------------------------------------------------------------
 * A sync run
 * ---------------------------------------------------------------------------------------------- */

/** One item as the API carries it: a live payload, or a tombstone (`deleted: true`). */
export interface LibrarySyncChange {
  kind: LibraryItemKind;
  id: string;
  updatedAt: string;
  /** Sent changes only: the cloud copy's `updatedAt` this was merged with (null: none seen). */
  baseUpdatedAt?: string | null | undefined;
  deleted?: true | undefined;
  payload?: LibrarySyncPayload | undefined;
}

/** What the device remembers about an item as the cloud last had it. */
export interface LibrarySyncBase {
  /** The fingerprint of the cloud's copy; absent when the cloud copy is a deletion. */
  fingerprint?: LibraryFingerprint | undefined;
  /** The cloud copy's `updatedAt`. Uploads are stamped later than it. */
  updatedAt: string;
  /**
   * The fingerprint key of a local version the API turned away (invalid, or over a limit). That
   * version is not sent again; a later local change is.
   */
  heldKey?: string | undefined;
  /** A cloud change not merged yet: the item kept changing here while it was being merged. */
  pending?: LibrarySyncChange | undefined;
}

export interface LibrarySyncState {
  cursor: string;
  /** Keyed by {@link librarySyncKey}. */
  bases: Map<string, LibrarySyncBase>;
}

export const librarySyncKey = (kind: LibraryItemKind, id: string): string => `${kind}:${id}`;

/** A local change for the app to store, guarded by the local version it was computed from. */
export interface LibraryLocalWrite {
  kind: LibraryItemKind;
  id: string;
  /** The payload to store, or null to delete the item. */
  payload: LibrarySyncPayload | null;
  /**
   * The local fingerprint key this was merged with (null: no local item). The app skips the write
   * when the stored item no longer matches it (changed meanwhile); the next run merges again.
   */
  expectedKey: string | null;
  /** When the change was made elsewhere. */
  updatedAt: string;
}

export interface LibraryPushResult {
  accepted: Array<{ kind: LibraryItemKind; id: string }>;
  newer: LibrarySyncChange[];
  rejected: Array<{ index: number; reason: string }>;
}

export interface LibrarySyncAdapter {
  /** Every syncable local item now, by kind and id (starters and other device-only items left out). */
  readLocal(): Promise<
    Map<string, { kind: LibraryItemKind; id: string; payload: LibrarySyncPayload }>
  >;
  readState(): Promise<LibrarySyncState>;
  /**
   * Applies changes from the cloud to local storage. Returns the keys it wrote or deleted; a write
   * whose guard failed is left out and merged again next run.
   */
  applyLocal(writes: readonly LibraryLocalWrite[]): Promise<Set<string>>;
  /** Saves what changed in the sync state (`null` removes a base). */
  saveState(
    cursor: string | null,
    bases: ReadonlyMap<string, LibrarySyncBase | null>
  ): Promise<void>;
  pull(since: string): Promise<{
    changes: LibrarySyncChange[];
    cursor: string;
    hasMore: boolean;
    reset?: boolean | undefined;
  }>;
  push(changes: readonly LibrarySyncChange[]): Promise<LibraryPushResult>;
  /** Stops the run (resolving false) when the account it runs for is no longer signed in. */
  isCurrent(): boolean;
}

export interface LibrarySyncOptions {
  now?: () => Date;
  /** Changes per push request (the API takes up to 25). */
  pushBatchSize?: number;
  /** Pages pulled per run before it stops, to bound one run. */
  maxPullPages?: number;
}

export interface LibrarySyncSummary {
  pulled: number;
  pushed: number;
  rejected: number;
}

/** Thrown by a run that stopped because another account signed in meanwhile. */
export class LibrarySyncCancelledError extends Error {
  public constructor() {
    super("The library sync was for an account that is no longer signed in.");
    this.name = "LibrarySyncCancelledError";
  }
}

/** Merges of one cloud change tried per run while the item keeps changing here. */
const MAX_APPLY_ATTEMPTS = 3;

const isoAfter = (now: Date, floor: string | undefined): string => {
  const floorTime = floor ? Date.parse(floor) : Number.NaN;
  const time = Number.isFinite(floorTime) ? Math.max(now.getTime(), floorTime + 1) : now.getTime();
  return new Date(time).toISOString();
};

/**
 * What a pulled change means for the local copy, given what the device remembered. Returns the
 * local write to make (or null for none).
 */
export const resolveRemoteChange = (
  change: LibrarySyncChange,
  local: LibrarySyncPayload | undefined,
  base: LibrarySyncBase | undefined
): LibraryLocalWrite | null => {
  const groups = librarySyncGroupsFor(change.kind);
  const localFingerprint = local ? fingerprintPayload(local, groups) : null;
  const expectedKey = localFingerprint ? fingerprintKey(localFingerprint) : null;
  const write = (payload: LibrarySyncPayload | null): LibraryLocalWrite => ({
    expectedKey,
    id: change.id,
    kind: change.kind,
    payload,
    updatedAt: change.updatedAt
  });

  if (change.deleted || !change.payload) {
    // Deleted elsewhere: goes here too, unless it was changed here since (then it is kept, and
    // sent again as a new item).
    return local && sameFingerprint(localFingerprint, base?.fingerprint) ? write(null) : null;
  }

  if (!local) {
    // Deleted here and not changed elsewhere since: the deletion goes out. Otherwise the cloud
    // copy comes (back).
    return base?.fingerprint &&
      sameFingerprint(fingerprintPayload(change.payload, groups), base.fingerprint)
      ? null
      : write(change.payload);
  }

  const merged = mergeLibraryPayloads(base?.fingerprint, local, change.payload, groups);
  return sameFingerprint(fingerprintPayload(merged, groups), localFingerprint)
    ? null
    : write(merged);
};

/**
 * What the device remembers of an item once the cloud has `change`. A deletion keeps its time
 * (with no fingerprint), so an item made again under the same id is sent as newer than it.
 */
const baseFor = (change: LibrarySyncChange): LibrarySyncBase =>
  change.deleted || !change.payload
    ? { updatedAt: change.updatedAt }
    : {
        fingerprint: fingerprintPayload(change.payload, librarySyncGroupsFor(change.kind)),
        updatedAt: change.updatedAt
      };

const chunk = <Value>(values: readonly Value[], size: number): Value[][] => {
  const chunks: Value[][] = [];

  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }

  return chunks;
};

/**
 * One sync run: pull what changed in the cloud and merge it in, then push what changed on the
 * device (merges included). Rejects with {@link LibrarySyncCancelledError} when the account
 * changes midway; what was saved before that stays saved.
 */
export const runLibrarySync = async (
  adapter: LibrarySyncAdapter,
  options: LibrarySyncOptions = {}
): Promise<LibrarySyncSummary> => {
  const now = options.now ?? (() => new Date());
  const pushBatchSize = options.pushBatchSize ?? 25;
  const maxPullPages = options.maxPullPages ?? 50;
  const ensureCurrent = () => {
    if (!adapter.isCurrent()) {
      throw new LibrarySyncCancelledError();
    }
  };

  const state = await adapter.readState();
  const bases = new Map(state.bases);
  let cursor = state.cursor;
  let pulled = 0;
  const deferred = new Set<string>();

  /**
   * Merges cloud changes into local storage and records the cloud's copies as the new bases. A
   * write skipped because the item changed meanwhile is merged again with the new version (a few
   * times); one still not written is kept as the base's `pending` change, merged first next run,
   * and nothing is sent for the item until then (it would overwrite the change not yet merged).
   */
  const applyRemote = async (changes: readonly LibrarySyncChange[]) => {
    const changedBases = new Map<string, LibrarySyncBase | null>();
    let remaining = changes;

    for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS && remaining.length; attempt += 1) {
      const local = await adapter.readLocal();
      const writes = new Map<string, LibraryLocalWrite>();

      for (const change of remaining) {
        const key = librarySyncKey(change.kind, change.id);
        const write = resolveRemoteChange(change, local.get(key)?.payload, bases.get(key));

        if (write) {
          writes.set(key, write);
        }
      }

      ensureCurrent();
      const written = writes.size ? await adapter.applyLocal([...writes.values()]) : new Set();
      const skipped: LibrarySyncChange[] = [];

      for (const change of remaining) {
        const key = librarySyncKey(change.kind, change.id);

        if (writes.has(key) && !written.has(key)) {
          skipped.push(change);
          continue;
        }

        const base = baseFor(change);
        deferred.delete(key);
        bases.set(key, base);
        changedBases.set(key, base);
      }

      remaining = skipped;
    }

    for (const change of remaining) {
      const key = librarySyncKey(change.kind, change.id);
      const base: LibrarySyncBase = {
        fingerprint: bases.get(key)?.fingerprint,
        pending: change,
        updatedAt: change.updatedAt
      };
      deferred.add(key);
      bases.set(key, base);
      changedBases.set(key, base);
    }

    return changedBases;
  };

  // 0. Changes left unmerged last run.
  const pending = [...bases.values()].flatMap((base) => (base.pending ? [base.pending] : []));

  if (pending.length) {
    ensureCurrent();
    await adapter.saveState(null, await applyRemote(pending));
  }

  // 1. Pull.
  for (let page = 0; page < maxPullPages; page += 1) {
    ensureCurrent();
    const response = await adapter.pull(cursor);
    ensureCurrent();

    if (response.reset) {
      // The cloud lost what it had: everything here goes out again as new.
      const forgotten = new Map([...bases.keys()].map((key) => [key, null] as const));
      bases.clear();
      await adapter.saveState(null, forgotten);
    }

    const changedBases = await applyRemote(response.changes);
    pulled += response.changes.length;
    cursor = response.cursor;
    await adapter.saveState(cursor, changedBases);

    if (!response.hasMore) {
      break;
    }
  }

  // 2. Push what differs from the cloud's copy.
  ensureCurrent();
  const local = await adapter.readLocal();
  const outgoing: LibrarySyncChange[] = [];
  const sentKeys = new Map<string, string | null>();

  for (const [key, item] of local) {
    const fingerprint = fingerprintPayload(item.payload, librarySyncGroupsFor(item.kind));
    const base = bases.get(key);
    const localKey = fingerprintKey(fingerprint);

    if (
      deferred.has(key) ||
      sameFingerprint(fingerprint, base?.fingerprint) ||
      base?.heldKey === localKey
    ) {
      continue;
    }

    outgoing.push({
      baseUpdatedAt: base?.updatedAt ?? null,
      id: item.id,
      kind: item.kind,
      payload: item.payload,
      updatedAt: isoAfter(now(), base?.updatedAt)
    });
    sentKeys.set(key, localKey);
  }

  for (const [key, base] of bases) {
    if (!local.has(key) && !deferred.has(key) && base.fingerprint) {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator) as LibraryItemKind;
      outgoing.push({
        baseUpdatedAt: base.updatedAt,
        deleted: true,
        id: key.slice(separator + 1),
        kind,
        updatedAt: isoAfter(now(), base.updatedAt)
      });
      sentKeys.set(key, null);
    }
  }

  let pushed = 0;
  let rejected = 0;

  for (const batch of chunk(outgoing, pushBatchSize)) {
    ensureCurrent();
    const result = await adapter.push(batch);
    ensureCurrent();
    const changedBases = new Map<string, LibrarySyncBase | null>();

    for (const ref of result.accepted) {
      const key = librarySyncKey(ref.kind, ref.id);
      const sent = batch.find((change) => librarySyncKey(change.kind, change.id) === key);

      if (!sent) {
        continue;
      }

      const base = baseFor(sent);
      bases.set(key, base);
      changedBases.set(key, base);
      pushed += 1;
    }

    for (const refused of result.rejected) {
      const sent = batch[refused.index];

      if (!sent) {
        continue;
      }

      const key = librarySyncKey(sent.kind, sent.id);
      const heldKey = sentKeys.get(key);
      const previous = bases.get(key);
      rejected += 1;

      if (heldKey) {
        const base: LibrarySyncBase = {
          ...(previous ?? { updatedAt: new Date(0).toISOString() }),
          heldKey
        };
        bases.set(key, base);
        changedBases.set(key, base);
      }
    }

    await adapter.saveState(null, changedBases);

    if (result.newer.length) {
      // Another device's copy arrived after the pull: merge it now, send the result next run.
      await adapter.saveState(null, await applyRemote(result.newer));
    }
  }

  return { pulled, pushed, rejected };
};
