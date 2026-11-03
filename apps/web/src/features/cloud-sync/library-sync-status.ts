/**
 * What cloud sync is doing, for screens to show, and the actions they offer. Kept apart from the
 * sync itself (./library-sync), which loads the API contracts: screens import this small module,
 * and the actions load the rest when they are used.
 */
import { useSyncExternalStore } from "react";

export type LibrarySyncPhase =
  /** Signed out, cloud sync isn't switched on, or it hasn't started yet: nothing to show. */
  | "off"
  | "syncing"
  | "synced"
  | "offline"
  | "error"
  /** This browser's cookbook is linked to another account; it syncs with that one only. */
  | "other_account";

export interface LibrarySyncStatus {
  /** The signed-in account this describes (null when signed out). */
  account: string | null;
  phase: LibrarySyncPhase;
  /** When the cookbook last finished syncing (ms since the epoch). */
  lastSyncedAt: number | null;
  /** What went wrong, for the "error" phase. */
  error: string | null;
  /** Recipes and collections the cloud turned away (too large, or past a limit). */
  held: number;
}

const initialStatus: LibrarySyncStatus = {
  account: null,
  error: null,
  held: 0,
  lastSyncedAt: null,
  phase: "off"
};

let status = initialStatus;
const listeners = new Set<() => void>();

export const getLibrarySyncStatus = (): LibrarySyncStatus => status;

export const subscribeLibrarySyncStatus = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** For the sync: records what it is doing now. */
export const setLibrarySyncStatus = (patch: Partial<LibrarySyncStatus>): void => {
  status = { ...status, ...patch };
  listeners.forEach((listener) => {
    listener();
  });
};

export function useLibrarySyncStatus(): LibrarySyncStatus {
  return useSyncExternalStore(
    subscribeLibrarySyncStatus,
    getLibrarySyncStatus,
    getLibrarySyncStatus
  );
}

const loadSync = () => import("./library-sync");

/** Syncs now (joining a sync already running). */
export const requestLibrarySyncNow = async (): Promise<void> => {
  await (await loadSync()).syncLibraryNow();
};

/** Changes made here that the account the cookbook is linked to doesn't have yet. */
export const countChangesNotSynced = async (): Promise<number> =>
  (await loadSync()).countChangesNotSynced();

/** Replaces this browser's cookbook with the signed-in account's, and syncs it. */
export const switchToAccountCookbook = async (): Promise<void> => {
  await (await loadSync()).switchToSignedInCookbook();
};

export function resetLibrarySyncStatusForTests(): void {
  status = initialStatus;
  listeners.clear();
}
