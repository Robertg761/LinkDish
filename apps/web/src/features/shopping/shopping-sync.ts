import { useEffect, useSyncExternalStore } from "react";

import { apiClient } from "../../api/client";
import { isNetworkError, isOffline, isTimeoutError } from "../../api/error-message";
import { getApiErrorKind } from "../../api/errors";
import { asAccount, isAccountChangedError } from "../../api/request-binding";
import { useAuth } from "../../auth/AuthProvider";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import {
  claimShoppingChanges,
  hasShoppingItemsOutOfView,
  loadShoppingList,
  setShoppingListHousehold,
  ShoppingSyncCancelledError,
  syncShoppingItems
} from "./shopping-list-store";

import type { ShoppingWriteOptions } from "./shopping-list-store";
import type { WebStorageKind } from "../../platform/safe-storage";

/**
 * Household sync for the shopping list, kept off the critical path:
 *
 * - Household mode (is this account in a household?) is cached per account and refreshed in the
 *   background, so the list renders from IndexedDB immediately (members who share a device each
 *   get theirs at once).
 * - Syncs are coalesced: a burst of check-offs becomes one push + pull, and a sync requested while
 *   one is running runs once more afterwards.
 * - One focus / visibility / online listener and a gentle poll while a list is on screen.
 * - Tabs share the household cache: a tab takes in an answer another tab wrote for its account.
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

/** What a household check answered for an account. */
interface HouseholdAnswer {
  checkedAt: number;
  household: boolean;
  /** Added later: caches written before it make the next sync check the household first. */
  householdId?: string | undefined;
}

interface HouseholdCache extends HouseholdAnswer {
  userId: string;
}

/**
 * The stored cache: the last answer on this device (the account sign-in assumes while auth
 * loads), plus, added later, the last answer for each account that checked here (`accounts`), so
 * members who share a device each see their household's list as soon as they sign in.
 */
interface StoredHouseholdCache extends HouseholdCache {
  accounts?: Record<string, HouseholdAnswer> | undefined;
}

const MAX_CACHED_ACCOUNTS = 8;
/** How long adding a recipe waits for a household check, so it adds up with that list. */
const HOUSEHOLD_WAIT_MS = 3_000;

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
/** Household ids being recorded on unsent changes (claimShoppingChanges), one after another. */
let claims: Promise<void> = Promise.resolve();
/** When the household answer this tab's state holds was checked (0: none yet). */
let householdAnsweredAt = 0;
/**
 * False while the household this tab's state holds is only remembered from an earlier sign-in of
 * the account (another account has checked on this device since). The list shows it and takes
 * changes, but nothing is sent until this sign-in's check confirms it: the account may have
 * moved, and the unsent changes on this device (other members' too) must only reach theirs.
 */
let householdConfirmed = false;
/** Answers this tab's checks got, for when storage can't be written (or read). */
const answersInMemory = new Map<string, HouseholdCache>();
let listeningToOtherTabs = false;
/** The account auth last settled on (null: signed out, or not settled yet). */
let settledUserId: string | null = null;
/**
 * Auth is resolving another account than the one it last settled on (Clerk switched straight to
 * another account's session): someone is signed in, but who, and so which household, isn't known.
 */
let accountResolving = false;

const setState = (patch: Partial<ShoppingSyncState>) => {
  state = { ...state, ...patch };

  // The list shows this household's items (signed in without a known one, none of any
  // household's); other households' changes wait out of sight. Unchanged scopes are ignored.
  setShoppingListHousehold(state.householdId, {
    signedIn: state.userId !== null || accountResolving
  });

  listeners.forEach((listener) => {
    listener();
  });
};

const parseAnswer = (userId: unknown, value: unknown): HouseholdCache | null => {
  const { checkedAt, household, householdId } = (value ?? {}) as Partial<HouseholdAnswer>;

  if (
    typeof userId !== "string" ||
    !userId ||
    typeof household !== "boolean" ||
    typeof checkedAt !== "number"
  ) {
    return null;
  }

  return {
    checkedAt,
    household,
    userId,
    ...(household && typeof householdId === "string" && householdId ? { householdId } : {})
  };
};

/** The stored answers: the last one on this device, and each account's. */
const readStoredCache = (
  kind: WebStorageKind
): { accounts: HouseholdCache[]; last: HouseholdCache | null } => {
  try {
    const raw = safeGetItem(SHOPPING_HOUSEHOLD_CACHE_KEY, kind);
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredHouseholdCache> | null) : null;
    const last = parsed ? parseAnswer(parsed.userId, parsed) : null;
    const accounts =
      parsed && typeof parsed.accounts === "object" && parsed.accounts !== null
        ? Object.entries(parsed.accounts)
            .map(([userId, answer]) => parseAnswer(userId, answer))
            .filter((answer): answer is HouseholdCache => answer !== null)
        : [];

    return { accounts, last };
  } catch {
    // A corrupt cache only costs one network check.
    return { accounts: [], last: null };
  }
};

const newest = (answers: ReadonlyArray<HouseholdCache | null | undefined>): HouseholdCache | null =>
  answers.reduce<HouseholdCache | null>(
    (best, answer) => (answer && (!best || answer.checkedAt > best.checkedAt) ? answer : best),
    null
  );

/**
 * The last answer on this device, for whichever account (session storage holds it when local
 * storage can't be written).
 */
const readHouseholdCache = (): HouseholdCache | null =>
  newest([readStoredCache("local").last, readStoredCache("session").last]);

/** The newest answer this device has for `userId`. */
const readAccountHousehold = (userId: string): HouseholdCache | null => {
  const stored = [readStoredCache("local"), readStoredCache("session")].flatMap(
    ({ accounts, last }) => [last, ...accounts]
  );

  return newest(
    [...stored, answersInMemory.get(userId)].filter((answer) => answer?.userId === userId)
  );
};

const writeHouseholdCache = (cache: HouseholdCache) => {
  answersInMemory.set(cache.userId, cache);

  const serialize = (kind: WebStorageKind) => {
    const accounts = [
      cache,
      ...readStoredCache(kind).accounts.filter((answer) => answer.userId !== cache.userId)
    ]
      .sort((a, b) => b.checkedAt - a.checkedAt)
      .slice(0, MAX_CACHED_ACCOUNTS);
    const stored: StoredHouseholdCache = {
      ...cache,
      accounts: Object.fromEntries(accounts.map(({ userId, ...answer }) => [userId, answer]))
    };
    return JSON.stringify(stored);
  };

  if (!safeSetItem(SHOPPING_HOUSEHOLD_CACHE_KEY, serialize("local"))) {
    // Local storage is full or blocked: this tab keeps it across reloads at least.
    safeSetItem(SHOPPING_HOUSEHOLD_CACHE_KEY, serialize("session"), "session");
  }
};

/**
 * Whether an answer remembered for `userId` can be used without checking first, as it always
 * could: it is the last one on this device, so no other account has checked since.
 */
const isLastAnswerFor = (userId: string): boolean => readHouseholdCache()?.userId === userId;

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

/**
 * Takes in what a household check for `userId` (the signed-in account) answered, in this tab or
 * another: records the household on the unsent changes that are for it, and shows its list.
 * Returns true when the account joined a household or moved to another, so the list should sync.
 */
const applyHouseholdAnswer = (
  userId: string,
  householdId: string | null,
  checkedAt: number
): boolean => {
  householdAnsweredAt = checkedAt;
  householdConfirmed = true;

  if (householdId) {
    // Unsent changes that don't know their household yet are this account's; and if the
    // account moved household, its own changes for the old one can only go to this one now.
    claims = claims
      .then(() => claimShoppingChanges(householdId, { userId }))
      .catch(() => undefined);
  }

  const household = householdId !== null;
  const householdChanged =
    household &&
    (state.mode !== "household" ||
      (state.householdId !== null && state.householdId !== householdId));
  setState({ householdId, mode: household ? "household" : "local", modeResolved: true });
  return householdChanged;
};

/**
 * Takes in a newer answer another tab wrote to the shared household cache for this account, so no
 * tab keeps showing, stamping or syncing a household another tab has already seen it leave.
 * Returns true when the list should sync (see applyHouseholdAnswer).
 */
const adoptHouseholdCache = (): boolean => {
  const userId = state.userId;
  const cache = userId ? readAccountHousehold(userId) : null;

  if (
    !userId ||
    !cache ||
    cache.checkedAt < householdAnsweredAt ||
    (cache.household && !cache.householdId)
  ) {
    return false;
  }

  const { householdId, mode } = cachedHouseholdState(cache);

  if (state.modeResolved && state.householdId === householdId && state.mode === mode) {
    if (cache.checkedAt > householdAnsweredAt) {
      // Checked again since the answer this tab holds (in another tab): that confirms it.
      householdConfirmed = true;
    }

    householdAnsweredAt = cache.checkedAt;
    return false;
  }

  return applyHouseholdAnswer(userId, householdId, cache.checkedAt);
};

const onOtherTabStorage = (event: StorageEvent) => {
  if (event.key !== null && event.key !== SHOPPING_HOUSEHOLD_CACHE_KEY) {
    return;
  }

  // Until auth settles the account is only assumed; settling reads the cache again.
  if (!credentialsPending && adoptHouseholdCache() && lifecycleUsers > 0) {
    void syncShoppingNow();
  }
};

const listenToOtherTabs = () => {
  if (listeningToOtherTabs || typeof window === "undefined") {
    return;
  }

  listeningToOtherTabs = true;
  window.addEventListener("storage", onOtherTabStorage);
};

/** Checks (in the background) whether the signed-in account shares a household list. */
export function refreshShoppingHousehold(options: { force?: boolean } = {}): Promise<void> {
  const userId = state.userId;

  if (!userId || credentialsPending) {
    return Promise.resolve();
  }

  // Another tab may have checked since this one did.
  if (adoptHouseholdCache() && lifecycleUsers > 0) {
    void syncShoppingNow();
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
  // Asked only as this account: an answer for another one Clerk switches to meanwhile would be
  // remembered as this account's household.
  const run = asAccount(userId, () => apiClient.getHousehold())
    .then(
      (response) => {
        if (state.userId !== userId) {
          return;
        }

        const householdId = response.household?.id ?? null;
        const checkedAt = Date.now();
        householdCheckError = null;
        writeHouseholdCache({
          checkedAt,
          household: householdId !== null,
          ...(householdId ? { householdId } : {}),
          userId
        });

        // Joined one, or moved to another: sync now so the list follows the new household.
        if (applyHouseholdAnswer(userId, householdId, checkedAt) && lifecycleUsers > 0) {
          void syncShoppingNow();
        }
      },
      (error: unknown) => {
        // Not sent: another account signed in first, and its own check follows.
        if (isAccountChangedError(error)) {
          return;
        }

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
  listenToOtherTabs();

  if (credentialsPending) {
    if (!accountConfigured) {
      // Until auth settles, assume the last account seen on this device.
      const cache = readHouseholdCache();
      accountConfigured = true;

      if (cache) {
        householdAnsweredAt = cache.checkedAt;
        householdConfirmed = true;
        setState({ ...cachedHouseholdState(cache), modeResolved: false, userId: cache.userId });
      }
    } else if (settledUserId !== null && (account.userId ?? null) !== settledUserId) {
      // The account the list was for is gone and the next one is still being looked up: none of
      // the last one's household shows, or takes changes, meanwhile.
      accountResolving = true;
      syncWhenReady = false;
      householdAnsweredAt = 0;
      householdConfirmed = false;
      settledUserId = null;
      setState({
        error: null,
        householdId: null,
        lastSyncedAt: null,
        mode: "local",
        modeResolved: false,
        phase: "idle",
        userId: null
      });
    }

    return;
  }

  accountConfigured = true;
  const userId = account.isAuthenticated ? (account.userId ?? null) : null;
  settledUserId = userId;

  if (accountResolving) {
    accountResolving = false;
    // Scoped again below, for the account auth settled on (none of any household's until it's
    // known); signed out, to this device's list.
    setShoppingListHousehold(state.householdId, { signedIn: userId !== null });
  }

  if (!userId) {
    syncWhenReady = false;
    householdAnsweredAt = 0;
    householdConfirmed = false;

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
    // This account's last answer here, even when another account has checked since (it is then
    // shown at once but only confirmed by the check below).
    const cached = readAccountHousehold(userId);

    if (state.userId !== userId) {
      householdAnsweredAt = cached?.checkedAt ?? 0;
      householdConfirmed = isLastAnswerFor(userId);
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
      householdAnsweredAt = cached.checkedAt;
      householdConfirmed = isLastAnswerFor(userId);
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

const classifyError = (error: unknown): ShoppingSyncPhase => {
  // The API client reports unreachable servers and timeouts as errors of those kinds.
  const kind = getApiErrorKind(error);
  return isOffline() ||
    kind === "network" ||
    kind === "timeout" ||
    isNetworkError(error) ||
    isTimeoutError(error)
    ? "offline"
    : "error";
};

/**
 * One sync with the household this device is in. Which household that is gets checked first
 * when it isn't known yet (a cache from before household ids) or only remembered from an earlier
 * sign-in (see householdConfirmed), since changes must only go to the household they belong to.
 * Resolves false when the account turned out not to be in one.
 */
const syncWithHousehold = async (): Promise<boolean> => {
  // Another tab may have seen this account move, or leave, since this one checked.
  adoptHouseholdCache();

  if (state.mode === "household" && (!state.householdId || !householdConfirmed)) {
    await refreshShoppingHousehold({ force: true });
  }

  await claims;

  if (state.mode !== "household") {
    return false;
  }

  const { householdId, userId } = state;

  if (!householdId || !householdConfirmed) {
    // Reported like the check's own failure (offline, timeout...) so the status reads right.
    throw householdCheckError instanceof Error
      ? householdCheckError
      : new Error("We couldn't check your household.");
  }

  // Someone else signing in, or the household changing, stops it before the next request.
  await syncShoppingItems({
    canSync: true,
    householdId,
    isCurrent: () => state.userId === userId && state.householdId === householdId,
    ...(userId ? { userId } : {})
  });
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
        if (error instanceof ShoppingSyncCancelledError) {
          // It was for an account or household this device no longer syncs: sync the current one.
          syncAgain = true;
          setState({ error: null, phase: "idle" });
          return;
        }

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
 * Before adding items while the signed-in account's household isn't known yet: asks for it now,
 * so the items record their household (and can only ever go there) as soon as it answers. When
 * this device holds household items the list leaves out until then (it may be this account's
 * household, e.g. another member used the device last), it also waits for the answer, up to
 * `timeoutMs`, so the new items add up with that list instead of going on next to it. Never
 * rejects.
 */
export async function waitForShoppingHousehold(timeoutMs = HOUSEHOLD_WAIT_MS): Promise<void> {
  if (!state.userId || credentialsPending || state.householdId) {
    return;
  }

  const answered = refreshShoppingHousehold({ force: true });
  const hidden = await hasShoppingItemsOutOfView().catch(() => false);

  if (!hidden) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);

    void answered.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
  claims = Promise.resolve();
  householdAnsweredAt = 0;
  householdConfirmed = false;
  answersInMemory.clear();
  accountConfigured = false;
  settledUserId = null;
  accountResolving = false;

  if (listeningToOtherTabs) {
    window.removeEventListener("storage", onOtherTabStorage);
    listeningToOtherTabs = false;
  }

  state = initialState;
  listeners.forEach((listener) => {
    listener();
  });
}
