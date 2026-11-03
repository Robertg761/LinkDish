/**
 * Cloud sync of the signed-in account's cookbook (recipes with their notes, favorites, tags,
 * ratings and cook log, and collections) between this browser and the account's other devices.
 *
 * - The cookbook on this browser is linked to one account: the first to sign in here (the two
 *   cookbooks are merged). Signing out keeps it here; another account that signs in can replace
 *   it with its own (see {@link switchToSignedInCookbook}) but never syncs with it.
 * - A run pulls what changed in the cloud, merges it in, then pushes what changed here (see
 *   `runLibrarySync` in @linkdish/recipe-domain). Runs are serialized across tabs (Web Locks) and
 *   coalesced in a tab; changes here, focus, coming online and a slow poll start one.
 * - It is only for the account it started for: it stops before its next request or write once
 *   someone else signs in, and every request carries that account (see `asAccount`).
 * - The API answers 404 while cloud sync is switched off: sync then stays quiet for a while.
 */
import { createLibrarySyncTransport } from "@linkdish/api-client/src/library-sync";
import {
  LibrarySyncCancelledError,
  runLibrarySync
} from "@linkdish/recipe-domain/src/library-sync";

import { apiClient } from "../../api/client";
import {
  getFriendlyErrorMessage,
  isNetworkError,
  isOffline,
  isTimeoutError
} from "../../api/error-message";
import { getApiErrorKind, isExtractorApiError } from "../../api/errors";
import { asAccount, isAccountChangedError } from "../../api/request-binding";
import { getCurrentAccount } from "../../auth/account-scope";
import { subscribeDataChanges } from "../../data/change-feed";

import { setLibrarySyncStatus } from "./library-sync-status";
import {
  applyLibraryWrites,
  countUnsyncedLibraryChanges,
  linkLibrary,
  readLibraryLink,
  readLibrarySyncState,
  readLocalLibrary,
  replaceLocalLibrary,
  saveLibrarySyncState,
  unlinkLibrary
} from "./library-sync-storage";

import type { LibrarySyncAdapter } from "@linkdish/recipe-domain/src/library-sync";

/** A change here waits this long for more before it is synced (typing, a burst of favorites). */
export const LIBRARY_SYNC_DELAY_MS = 4_000;
const WAKE_THROTTLE_MS = 30_000;
const POLL_INTERVAL_MS = 5 * 60_000;
/** How long sync stays quiet after the API said it is switched off. */
const UNAVAILABLE_RETRY_MS = 30 * 60_000;
const LOCK_NAME = "linkdish-library-sync";

export interface LibrarySyncAccount {
  credentialsKey: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  userId: string | null;
}

/** The signed-in account sync runs for, once its credentials are ready (null: none). */
let syncAccount: string | null = null;
let lastCredentialsKey: string | null | undefined;
let inflight: Promise<void> | null = null;
let syncAgain = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let unavailableUntil = 0;
/** Above zero while sync writes to the cookbook: those writes start no sync of their own. */
let applying = 0;
let detachLifecycle: (() => void) | null = null;

const createAdapter = (account: string, isCurrent: () => boolean): LibrarySyncAdapter => ({
  ...createLibrarySyncTransport(apiClient, {
    // Every request goes out only as the account the run is for.
    send: (request) => asAccount(account, request)
  }),
  applyLocal: async (writes) => {
    applying += 1;

    try {
      return await applyLibraryWrites(account, writes);
    } finally {
      applying -= 1;
    }
  },
  isCurrent,
  readLocal: readLocalLibrary,
  readState: () => readLibrarySyncState(account),
  saveState: (cursor, bases) => saveLibrarySyncState(account, cursor, bases)
});

/* ------------------------------------------------------------------------------------------------
 * Runs
 * ---------------------------------------------------------------------------------------------- */

/** Runs `work` while no other tab syncs (where the browser has Web Locks; otherwise just runs it). */
const withSyncLock = <Result>(work: () => Promise<Result>): Promise<Result> => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks?.request ? (locks.request(LOCK_NAME, work) as Promise<Result>) : work();
};

const isCancelled = (error: unknown): boolean =>
  error instanceof LibrarySyncCancelledError || isAccountChangedError(error);

const isUnavailable = (error: unknown): boolean =>
  isExtractorApiError(error) && error.statusCode === 404;

const isOfflineError = (error: unknown): boolean => {
  const kind = getApiErrorKind(error);
  return (
    isOffline() ||
    kind === "network" ||
    kind === "timeout" ||
    isNetworkError(error) ||
    isTimeoutError(error)
  );
};

const countHeld = async (account: string): Promise<number> => {
  const { bases } = await readLibrarySyncState(account);
  return [...bases.values()].filter((base) => base.heldKey).length;
};

const runFor = async (account: string): Promise<void> => {
  const isCurrent = () => syncAccount === account && getCurrentAccount() === account;

  try {
    await withSyncLock(async () => {
      const link = (await readLibraryLink()) ?? (await linkLibrary(account));

      if (!isCurrent()) {
        throw new LibrarySyncCancelledError();
      }

      if (link.account !== account) {
        setLibrarySyncStatus({ error: null, phase: "other_account" });
        return;
      }

      setLibrarySyncStatus({ error: null, phase: "syncing" });
      await runLibrarySync(createAdapter(account, isCurrent));
      const held = await countHeld(account);

      if (isCurrent()) {
        setLibrarySyncStatus({ error: null, held, lastSyncedAt: Date.now(), phase: "synced" });
      }
    });
  } catch (error) {
    if (!isCurrent()) {
      return;
    }

    if (isCancelled(error)) {
      // The link changed under it (another tab switched cookbooks): look again.
      syncAgain = true;
      return;
    }

    if (isUnavailable(error)) {
      unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      setLibrarySyncStatus({ error: null, phase: "off" });
      return;
    }

    if (isOfflineError(error)) {
      setLibrarySyncStatus({ error: null, phase: "offline" });
      return;
    }

    console.warn("LinkDish couldn't sync the cookbook.", error);
    setLibrarySyncStatus({
      error: getFriendlyErrorMessage(error, "generic"),
      phase: "error"
    });
  }
};

/** Syncs the signed-in account's cookbook now (joining a sync already running). */
export function syncLibraryNow(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  const account = syncAccount;

  if (!account || Date.now() < unavailableUntil) {
    return Promise.resolve();
  }

  if (inflight) {
    // It may have read the cookbook before the change this sync is for: once more after it.
    syncAgain = true;
    return inflight.then(() => inflight ?? undefined);
  }

  const run = runFor(account).finally(() => {
    inflight = null;

    if (syncAgain) {
      syncAgain = false;
      void syncLibraryNow();
    }
  });

  inflight = run;
  return run;
}

/** Schedules a sync after changes here; calls within the delay become one sync. */
export function requestLibrarySync(delayMs = LIBRARY_SYNC_DELAY_MS): void {
  if (!syncAccount || syncTimer) {
    return;
  }

  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncLibraryNow();
  }, delayMs);
}

const attachLifecycle = (): (() => void) => {
  let lastWakeAt = Date.now();
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

  const wake = () => {
    if (!visible() || Date.now() - lastWakeAt < WAKE_THROTTLE_MS) {
      return;
    }

    lastWakeAt = Date.now();
    void syncLibraryNow();
  };

  const onChange = (_change: unknown, source: "local" | "remote") => {
    // Another tab's change is synced by that tab; sync's own writes need no sync.
    if (source === "local" && applying === 0) {
      requestLibrarySync();
    }
  };

  const poll = setInterval(() => {
    if (visible() && !inflight) {
      void syncLibraryNow();
    }
  }, POLL_INTERVAL_MS);
  const unsubscribes = [
    subscribeDataChanges("savedRecipes", onChange),
    subscribeDataChanges("collections", onChange)
  ];

  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);

  return () => {
    clearInterval(poll);
    unsubscribes.forEach((unsubscribe) => {
      unsubscribe();
    });
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  };
};

/**
 * Tells sync who is signed in. Cheap to call on every render; nothing runs until auth has settled
 * and the account's credentials can be read.
 */
export function setLibrarySyncAccount(account: LibrarySyncAccount): void {
  if (account.loading || (account.isAuthenticated && account.credentialsKey === null)) {
    return;
  }

  const userId = account.isAuthenticated ? account.userId : null;
  const newCredentials = account.credentialsKey !== lastCredentialsKey;
  lastCredentialsKey = account.credentialsKey;

  if (userId === syncAccount && !newCredentials) {
    return;
  }

  const sameAccount = userId === syncAccount;
  syncAccount = userId;
  unavailableUntil = 0;

  if (!userId) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }

    detachLifecycle?.();
    detachLifecycle = null;
    setLibrarySyncStatus({ account: null, error: null, held: 0, lastSyncedAt: null, phase: "off" });
    return;
  }

  if (!sameAccount) {
    setLibrarySyncStatus({
      account: userId,
      error: null,
      held: 0,
      lastSyncedAt: null,
      phase: "off"
    });
  }

  detachLifecycle ??= attachLifecycle();
  void syncLibraryNow();
}

/** Changes made here that the account the cookbook is linked to doesn't have yet. */
export async function countChangesNotSynced(): Promise<number> {
  const link = await readLibraryLink();
  return link ? countUnsyncedLibraryChanges(link.account) : 0;
}

/**
 * Replaces this browser's cookbook (linked to another account) with the signed-in account's own,
 * and syncs it in. Changes made here that the other account hasn't synced are lost.
 */
export async function switchToSignedInCookbook(): Promise<void> {
  const account = syncAccount;

  if (!account) {
    return;
  }

  await withSyncLock(async () => {
    if (syncAccount === account && getCurrentAccount() === account) {
      await replaceLocalLibrary(account);
    }
  });
  await syncLibraryNow();
}

/**
 * Called once `account` is deleted: its cloud cookbook is gone, so this browser's cookbook stops
 * syncing with it. The recipes stay here.
 */
export async function forgetDeletedAccountLibrary(account: string): Promise<void> {
  await unlinkLibrary(account);
}

export function resetLibrarySyncForTests(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  detachLifecycle?.();
  detachLifecycle = null;
  syncAccount = null;
  lastCredentialsKey = undefined;
  inflight = null;
  syncAgain = false;
  syncTimer = null;
  unavailableUntil = 0;
  applying = 0;
}
