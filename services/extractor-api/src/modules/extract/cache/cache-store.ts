import { createBoundedExpiringMap } from "../../bounded-expiring-map.js";
import {
  getStoreString,
  isKeyValueStoreConfigured,
  setStoreString
} from "../../storage/upstash-store.js";

/*
 * Minimal string store for the extraction result cache and the fallback
 * hand-off. Production uses Upstash through the shared upstash-store helpers
 * with a short request timeout (a slow store must read as a miss, never stall
 * an import). Without Upstash (local dev, tests) entries live in a bounded,
 * expiring in-process map: cached recipes are tens of kilobytes each, so the
 * store's unbounded in-memory emulation is not used for them.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export const cacheStoreRequestTimeoutMs = 1_500;

export const createMemoryCacheStore = (maxEntries: number): CacheStore => {
  const entries = createBoundedExpiringMap<string>({ maxEntries });

  return {
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    set: (key, value, ttlSeconds) => {
      entries.set(key, value, Date.now() + ttlSeconds * 1_000);
      return Promise.resolve();
    }
  };
};

export const createDefaultCacheStore = ({
  maxMemoryEntries
}: {
  maxMemoryEntries: number;
}): CacheStore => {
  const memoryStore = createMemoryCacheStore(maxMemoryEntries);

  return {
    get: (key) =>
      isKeyValueStoreConfigured()
        ? getStoreString(key, { timeoutMs: cacheStoreRequestTimeoutMs })
        : memoryStore.get(key),
    set: async (key, value, ttlSeconds) => {
      if (!isKeyValueStoreConfigured()) {
        await memoryStore.set(key, value, ttlSeconds);
        return;
      }

      await setStoreString(key, value, {
        timeoutMs: cacheStoreRequestTimeoutMs,
        ttlSeconds
      });
    }
  };
};
