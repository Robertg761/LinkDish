import { useEffect, useSyncExternalStore } from "react";

import { apiClient } from "../../api/client";
import { isNetworkError, isOffline, isTimeoutError } from "../../api/error-message";
import { useAuth } from "../../auth/AuthProvider";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import { loadShoppingList, syncShoppingItems } from "./shopping-list-store";

import type { ShoppingWriteOptions } from "./shopping-list-store";

/**
 * Household sync for the shopping list, kept off the critical path:
 *
 * - Household mode (is this account in a household?) is cached per account and refreshed in the
 *   background, so the list renders from IndexedDB immediately.
 * - Syncs are coalesced: a burst of check-offs becomes one push + pull, and a sync requested while
 *   one is running runs once more afterwards.
 * - One focus / visibility / online listener and a gentle poll while a list is on screen.
 */

export type ShoppingMode = "local" | "household";
export type ShoppingSyncPhase = "idle" | "syncing" | "synced" | "offline" | "error";

export interface ShoppingSyncState {
  mode: ShoppingMode;
  /** True once we know (fresh or cached) whether this account shares a household list. */
  modeResolved: boolean;
  /**
   * The household the list syncs with (fresh or cached); null outside a household and until it
   * is known. Nothing is sent without it, so changes only ever reach the household they belong to.
   */
  householdId: string | null;
  userId: string | null;
  phase: ShoppingSyncPhase;
  lastSyncedAt: number | null;
  error: unknown;
}

export interface ShoppingAccount {
  loading: boolean;
  isAuthenticated: boolean;
  userId?: string | null | undefined;
  /**
   * `useAuth().credentialsKey`: null while a signed-in session's credentials can't be read yet
   * (a request would go out without them and be turned away). Callers that leave it out keep the
   * last key reported.
   */
  credentialsKey?: string | null | undefined;
}

export const SHOPPING_HOUSEHOLD_CACHE_KEY = "linkdish:web:shopping-household:v1";
const HOUSEHOLD_TTL_MS = 5 * 60_000;
export const SHOPPING_SYNC_DELAY_MS = 800;
const WAKE_THROTTLE_MS = 2_000;
const POLL_INTERVAL_MS = 30_000;

interface HouseholdCache {
  checkedAt: number;
  household: boolean;
  /** Added later: caches written before it make the next sync check the household first. */
  householdId?: string | undefined;
  userId: string;
}

const initialState: ShoppingSyncState = {
  error: null,
  householdId: null,
  lastSyncedAt: null,
  mode: "local",
  modeResolved: false,
  phase: "idle",
  userId: null
};

let state: ShoppingSyncState = initialState;
const listeners = new Set<() => void>();
let accountConfigured = false;
let householdInflight: Promise<void> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncDueAt = 0;
let syncInflight: Promise<void> | null = null;
let syncAgain = false;
let lifecycleUsers = 0;
let detachLifecycle: (() => void) | null = null;
/** The last `credentialsKey` reported (undefined: no caller has reported one). */
let credentialsKey: string | null | undefined;
/** The credentials the household check in flight was sent with. */
let householdInflightKey: string | null | undefined;
/** Auth is still settling: nothing goes to the network until it has. */
let credentialsPending = false;
/** A sync was asked for while auth was settling; it runs once it has. */
let syncWhenReady = false;
/** Why the last household check failed (cleared when one succeeds). */
let householdCheckError: unknown = null;

const setState = (patch: Partial<ShoppingSyncState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => {
    listener();
  });
};

const readHouseholdCache = (): HouseholdCache | null => {
  try {
    const raw = safeGetItem(SHOPPING_HOUSEHOLD_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<HouseholdCache>) : null;

    if (
      parsed &&
      typeof parsed.userId === "string" &&
      typeof parsed.household === "boolean" &&
      typeof parsed.checkedAt === "number"
    ) {
      const { checkedAt, household, householdId, userId } = parsed;
      return {
        checkedAt,
        household,
        userId,
        ...(household && typeof householdId === "string" && householdId ? { householdId } : {})
      };
    }
  } catch {
    // A corrupt cache only costs one network check.
  }

  return null;
};

const writeHouseholdCache = (cache: HouseholdCache) => {
  safeSetItem(SHOPPING_HOUSEHOLD_CACHE_KEY, JSON.stringify(cache));
};

/** Mode and household from a cache entry for this account. */
const cachedHouseholdState = (
  cache: HouseholdCache
): Pick<ShoppingSyncState, "householdId" | "mode"> => ({
  householdId: cache.household ? (cache.householdId ?? null) : null,
  mode: cache.household ? "household" : "local"
});

export const getShoppingSyncState = (): ShoppingSyncState => state;

export const subscribeShoppingSync = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Options for store writes: household items are marked for sync. */
export const getShoppingWriteOptions = (): ShoppingWriteOptions => ({
  canSync: state.mode === "household",
  ...(state.mode === "household" && state.householdId ? { householdId: state.householdId } : {}),
  ...(state.userId ? { userId: state.userId } : {})
});

/** Checks (in the background) whether the signed-in account shares a household list. */
export function refreshShoppingHousehold(options: { force?: boolean } = {}): Promise<void> {
  const userId = state.userId;

  if (!userId || credentialsPending) {
    return Promise.resolve();
  }

  const cache = readHouseholdCache();

  if (
    !options.force &&
    cache?.userId === userId &&
    Date.now() - cache.checkedAt < HOUSEHOLD_TTL_MS &&
    (!cache.household || Boolean(cache.householdId)) &&
    state.modeResolved
  ) {
    return Promise.resolve();
  }

  if (householdInflight) {
    // A check sent with older credentials may be turned away: ask again once it's done.
    return householdInflightKey === credentialsKey
      ? householdInflight
      : householdInflight.then(() => refreshShoppingHousehold(options));
  }

  householdInflightKey = credentialsKey;
  const run = apiClient
    .getHousehold()
    .then(
      (response) => {
        if (state.userId !== userId) {
          return;
        }

        const householdId = response.household?.id ?? null;
        const household = householdId !== null;
        householdCheckError = null;
        writeHouseholdCache({
          checkedAt: Date.now(),
          household,
          ...(householdId ? { householdId } : {}),
          userId
        });
        // Joined one, or moved to another: sync now so the list follows the new household.
        const householdChanged =
          household &&
          (state.mode !== "household" ||
            (state.householdId !== null && state.householdId !== householdId));
        setState({ householdId, mode: household ? "household" : "local", modeResolved: true });

        if (householdChanged && lifecycleUsers > 0) {
          void syncShoppingNow();
        }
      },
      (error: unknown) => {
        householdCheckError = error;

        if (state.userId === userId && !state.modeResolved) {
          // Unknown: keep working locally; the next focus retries.
          setState({ modeResolved: true });
        }
      }
    )
    .finally(() => {
      householdInflight = null;
    });

  householdInflight = run;
  return run;
}

/** Tells the sync layer who is signed in. Cheap to call on every render. */
export function setShoppingAccount(account: ShoppingAccount): void {
  const previousKey = credentialsKey;

  if (account.credentialsKey !== undefined) {
    credentialsKey = account.credentialsKey;
  }

  // Until auth settles, and a signed-in session's credentials can be read, a household check or
  // sync would be refused and not retried until the next focus: hold them until then.
  credentialsPending = account.loading || credentialsKey === null;

  if (credentialsPending) {
    if (!accountConfigured) {
      // Until auth settles, assume the last account seen on this device.
      const cache = readHouseholdCache();
      accountConfigured = true;

      if (cache) {
        setState({ ...cachedHouseholdState(cache), modeResolved: false, userId: cache.userId });
      }
    }

    return;
  }

  accountConfigured = true;
  const userId = account.isAuthenticated ? (account.userId ?? null) : null;

  if (!userId) {
    syncWhenReady = false;

    if (state.userId !== null || !state.modeResolved || state.mode !== "local") {
      setState({
        error: null,
        householdId: null,
        mode: "local",
        modeResolved: true,
        phase: "idle",
        userId: null
      });
    }

    return;
  }

  // The same account with new credentials (Clerk finished loading after the wait ran out): what
  // was asked with the old ones may have been refused, so check and sync again.
  const newCredentials =
    state.userId === userId &&
    typeof previousKey === "string" &&
    typeof credentialsKey === "string" &&
    previousKey !== credentialsKey;

  if (state.userId !== userId || !state.modeResolved) {
    const cache = readHouseholdCache();
    const cached = cache?.userId === userId ? cache : null;

    if (state.userId !== userId) {
      setState({
        error: null,
        householdId: null,
        lastSyncedAt: null,
        mode: "local",
        ...(cached ? cachedHouseholdState(cached) : {}),
        modeResolved: Boolean(cached),
        phase: "idle",
        userId
      });
    } else if (cached && !state.modeResolved) {
      setState({ ...cachedHouseholdState(cached), modeResolved: true });
    }

    void refreshShoppingHousehold();
  } else if (newCredentials) {
    void refreshShoppingHousehold({ force: true });
  }

  if (syncWhenReady || (newCredentials && lifecycleUsers > 0)) {
    syncWhenReady = false;

    if (state.mode === "household") {
      void syncShoppingNow();
    }
  }
}

const classifyError = (error: unknown): ShoppingSyncPhase =>
  isOffline() || isNetworkError(error) || isTimeoutError(error) ? "offline" : "error";

/**
 * One sync with the household this device is in. Which household that is gets checked first
 * when it isn't known yet (a cache from before household ids), since changes must only go to the
 * household they belong to. Resolves false when the account turned out not to be in one.
 */
const syncWithHousehold = async (): Promise<boolean> => {
  if (!state.householdId) {
    await refreshShoppingHousehold({ force: true });
  }

  if (state.mode !== "household") {
    return false;
  }

  if (!state.householdId) {
    // Reported like the check's own failure (offline, timeout...) so the status reads right.
    throw householdCheckError instanceof Error
      ? householdCheckError
      : new Error("We couldn't check your household.");
  }

  await syncShoppingItems({ canSync: true, householdId: state.householdId });
  return true;
};

/** Pushes local changes and pulls the household list now (joining a sync already running). */
export function syncShoppingNow(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  if (state.mode !== "household") {
    return loadShoppingList();
  }

  if (credentialsPending) {
    syncWhenReady = true;
    return loadShoppingList();
  }

  if (syncInflight) {
    syncAgain = true;
    return syncInflight;
  }

  setState({ phase: "syncing" });

  const run = syncWithHousehold()
    .then(
      (synced) => {
        setState(
          synced
            ? { error: null, lastSyncedAt: Date.now(), phase: "synced" }
            : { error: null, phase: "idle" }
        );
      },
      (error: unknown) => {
        setState({ error, phase: classifyError(error) });
      }
    )
    .finally(() => {
      syncInflight = null;

      if (syncAgain) {
        syncAgain = false;
        void syncShoppingNow();
      }
    });

  syncInflight = run;
  return run;
}

/**
 * Schedules a sync after local changes. Calls within the delay coalesce into one sync; an earlier
 * deadline wins. No-op outside a household.
 */
export function requestShoppingSync(options: { delayMs?: number } = {}): void {
  if (state.mode !== "household") {
    return;
  }

  const delay = Math.max(0, options.delayMs ?? SHOPPING_SYNC_DELAY_MS);
  const dueAt = Date.now() + delay;

  if (syncTimer && syncDueAt <= dueAt) {
    return;
  }

  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  syncDueAt = dueAt;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncShoppingNow();
  }, delay);
}

const attachLifecycle = (): (() => void) => {
  let lastWakeAt = 0;

  const wake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    const now = Date.now();

    if (now - lastWakeAt < WAKE_THROTTLE_MS) {
      return;
    }

    lastWakeAt = now;
    void refreshShoppingHousehold();

    if (state.mode === "household") {
      void syncShoppingNow();
    }
  };

  const poll = setInterval(() => {
    if (
      state.mode === "household" &&
      !syncInflight &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    ) {
      void syncShoppingNow();
    }
  }, POLL_INTERVAL_MS);

  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);

  return () => {
    clearInterval(poll);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  };
};

export function useShoppingSyncState(): ShoppingSyncState {
  return useSyncExternalStore(subscribeShoppingSync, getShoppingSyncState, getShoppingSyncState);
}

/** Keeps the sync layer told about the signed-in account; returns the sync state. */
export function useShoppingAccount(): ShoppingSyncState {
  const { credentialsKey: authCredentialsKey, isAuthenticated, loading, user } = useAuth();
  const userId = user?.id ?? null;

  // Keyed on the credentials (like use-import-usage and use-shared-recipes): nothing is asked
  // before a cached Clerk user's session can be read, and it is asked again when Clerk signs in.
  useEffect(() => {
    setShoppingAccount({ credentialsKey: authCredentialsKey, isAuthenticated, loading, userId });
  }, [authCredentialsKey, isAuthenticated, loading, userId]);

  return useShoppingSyncState();
}

/**
 * For the screen showing the list: account wiring, one shared focus/visibility/online listener
 * and a light poll, plus a sync whenever household mode switches on.
 */
export function useShoppingSync(): ShoppingSyncState {
  const current = useShoppingAccount();

  useEffect(() => {
    lifecycleUsers += 1;
    detachLifecycle ??= attachLifecycle();

    return () => {
      lifecycleUsers -= 1;

      if (lifecycleUsers === 0) {
        detachLifecycle?.();
        detachLifecycle = null;
      }
    };
  }, []);

  useEffect(() => {
    if (current.mode === "household" && current.userId) {
      void syncShoppingNow();
    }
  }, [current.mode, current.userId]);

  return current;
}

export function resetShoppingSyncForTests(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
  }

  detachLifecycle?.();
  detachLifecycle = null;
  lifecycleUsers = 0;
  syncTimer = null;
  syncDueAt = 0;
  syncInflight = null;
  syncAgain = false;
  householdInflight = null;
  householdInflightKey = undefined;
  credentialsKey = undefined;
  credentialsPending = false;
  syncWhenReady = false;
  householdCheckError = null;
  accountConfigured = false;
  state = initialState;
  listeners.forEach((listener) => {
    listener();
  });
}
