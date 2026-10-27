import {
  type LibraryItemKind,
  libraryItemKindSchema
} from "../../../../../packages/api-contracts/src/index.js";

/*
 * Where a synced library lives in Upstash. Shared by the library service and the backup and
 * restore of account data (storage/store-backup.ts), so the two never drift apart.
 */

export const libraryVersion = "v1";
export const libraryItemKinds: readonly LibraryItemKind[] = libraryItemKindSchema.options;

export const libraryKeysFor = (version: string) => ({
  changes: (userId: string) => `linkdish:library:${version}:changes:${userId}`,
  item: (userId: string, kind: LibraryItemKind, itemId: string) =>
    `linkdish:library:${version}:item:${userId}:${kind}:${itemId}`,
  live: (userId: string, kind: LibraryItemKind) =>
    `linkdish:library:${version}:live:${userId}:${kind}`,
  lock: (userId: string) => `linkdish:library:${version}:lock:${userId}`,
  rev: (userId: string) => `linkdish:library:${version}:rev:${userId}`
});

export const libraryKeys = libraryKeysFor(libraryVersion);

/* Deletes the lock only while it still holds the caller's token. */
export const releaseLibraryLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
