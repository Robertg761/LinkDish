/*
 * Process-local fallback stores (rate limits, quota counters) used when Upstash
 * is not configured. Plain Maps were never evicted, so a long-lived server grew
 * one entry per distinct network address forever. This keeps the same read and
 * write shape while bounding both time (per-entry expiry) and space (hard entry
 * cap, oldest write evicted first).
 */
export interface BoundedExpiringMap<T> {
  get(key: string, nowMs?: number): T | undefined;
  set(key: string, value: T, expiresAtMs: number | null, nowMs?: number): void;
  prune(nowMs?: number): number;
  size(): number;
  clear(): void;
}

interface BoundedExpiringMapEntry<T> {
  value: T;
  expiresAtMs: number | null;
}

export const createBoundedExpiringMap = <T>({
  maxEntries,
  pruneIntervalMs = 60_000
}: {
  maxEntries: number;
  pruneIntervalMs?: number;
}): BoundedExpiringMap<T> => {
  const entries = new Map<string, BoundedExpiringMapEntry<T>>();
  let lastPrunedAtMs: number | null = null;

  const prune = (nowMs = Date.now()): number => {
    let removed = 0;

    for (const [key, entry] of entries) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
        entries.delete(key);
        removed += 1;
      }
    }

    /* Entries without an expiry still cannot be allowed to grow without bound. */
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      entries.delete(oldestKey);
      removed += 1;
    }

    lastPrunedAtMs = nowMs;
    return removed;
  };

  const maybePrune = (nowMs: number): void => {
    if (
      entries.size > maxEntries ||
      lastPrunedAtMs === null ||
      nowMs - lastPrunedAtMs >= pruneIntervalMs
    ) {
      prune(nowMs);
    }
  };

  return {
    get: (key, nowMs = Date.now()) => {
      const entry = entries.get(key);

      if (!entry) {
        return undefined;
      }

      if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
        entries.delete(key);
        return undefined;
      }

      return entry.value;
    },
    set: (key, value, expiresAtMs, nowMs = Date.now()) => {
      /* Re-insert so iteration order stays "least recently written first". */
      entries.delete(key);
      entries.set(key, { value, expiresAtMs });
      maybePrune(nowMs);
    },
    prune,
    size: () => entries.size,
    clear: () => {
      entries.clear();
      lastPrunedAtMs = null;
    }
  };
};
