import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { AppState } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { mobileEnv } from "../../config/env";
import { createDebouncedWriter } from "../../lib/debouncedWriter";
import { useAccount } from "../account/AccountContext";

import {
  addShoppingItemsToList,
  applyRemoteShoppingItems,
  claimShoppingChanges,
  clearCheckedShoppingItemsInList,
  deleteShoppingItemInList,
  getPendingShoppingChanges,
  getShoppingListItems,
  markShoppingItemsSynced,
  markShoppingItemsSyncFailed,
  readShoppingItems,
  serializeShoppingItems,
  setAsideShoppingItems,
  setShoppingItemCheckedInList,
  sortShoppingItems,
  toApiShoppingItem,
  type AddShoppingItemInput,
  type MobileShoppingItem
} from "./store";

import type { ExtractorApiClient } from "@linkdish/api-client";
import type { ShoppingItem } from "@linkdish/recipe-domain";

const SHOPPING_ITEMS_STORAGE_KEY = "linkdish.shoppingItems.v1";
const SHOPPING_ITEMS_CORRUPT_BACKUP_STORAGE_KEY = "linkdish.shoppingItems.corrupt.v1";
/** Rapid check-offs are pushed together once the list has been quiet for this long. */
export const SHOPPING_SYNC_DEBOUNCE_MS = 400;
/** The list blob is written once edits settle (and immediately when the app backgrounds). */
export const SHOPPING_PERSIST_DEBOUNCE_MS = 250;
/** A mutation push reuses the household id for this long before asking the API again. */
const HOUSEHOLD_ID_CACHE_MS = 5 * 60 * 1000;

export interface ShoppingListState {
  canSyncShoppingList: boolean;
  hasLoadedShoppingItems: boolean;
  isRefreshingShoppingList: boolean;
  shoppingError: string | null;
  /**
   * Live items of the household the list syncs with (delete tombstones waiting to sync, and
   * records kept on this device for another household, are hidden). Signed out, every item.
   */
  shoppingItems: MobileShoppingItem[];
}

export interface ShoppingListActions {
  addItems: (inputs: AddShoppingItemInput[]) => void;
  clearCheckedItems: () => void;
  deleteItem: (id: string) => void;
  refreshShoppingList: () => Promise<void>;
  setItemChecked: (id: string, checked: boolean) => void;
}

export type ShoppingListContextValue = ShoppingListState & ShoppingListActions;

const ShoppingListStateContext = createContext<ShoppingListState | null>(null);
const ShoppingListActionsContext = createContext<ShoppingListActions | null>(null);

const getShoppingErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "Shopping list sync failed.";
};

/** The household is gone or no longer ours: forget the cached id so the next sync re-checks. */
const isHouseholdAccessError = (error: unknown): boolean =>
  error instanceof ExtractorApiError && (error.statusCode === 403 || error.statusCode === 404);

const OTHER_HOUSEHOLD_ITEM_PATTERN = /item belongs to another household/iu;

/**
 * The API refuses a whole batch (403) when any item in it is stored in another household. Other
 * refusals (not in a household, signed out) are about the account, not an item.
 */
const isOtherHouseholdItemError = (error: unknown): boolean => {
  if (!(error instanceof ExtractorApiError) || error.statusCode !== 403) {
    return false;
  }

  const { message } = (error.details ?? {}) as { message?: unknown };
  return [error.serverMessage, message].some(
    (text) => typeof text === "string" && OTHER_HOUSEHOLD_ITEM_PATTERN.test(text)
  );
};

/**
 * Sends `items` with `send`. A batch refused because it holds another household's item is halved
 * until that item is found, so one foreign item can't block the rest of the list (or the pull
 * after it). Returns each accepted batch's result and the refused ids; any other failure throws.
 */
const sendIsolatingOtherHouseholdItems = async <Item extends { id: string }, Result>(
  items: readonly Item[],
  send: (batch: Item[]) => Promise<Result>
): Promise<{ refusedIds: Set<string>; results: Result[] }> => {
  const refusedIds = new Set<string>();
  const results: Result[] = [];
  const sendBatch = async (batch: Item[]): Promise<void> => {
    try {
      results.push(await send(batch));
    } catch (error) {
      const [only] = batch;

      if (!isOtherHouseholdItemError(error) || !only) {
        throw error;
      }

      if (batch.length === 1) {
        refusedIds.add(only.id);
        return;
      }

      const middle = Math.ceil(batch.length / 2);
      await sendBatch(batch.slice(0, middle));
      await sendBatch(batch.slice(middle));
    }
  };

  if (items.length > 0) {
    await sendBatch([...items]);
  }

  return { refusedIds, results };
};

/** Thrown when a sync pass stops because the account it ran for is no longer signed in. */
class ShoppingSyncCancelledError extends Error {
  public constructor() {
    super("The shopping list sync stopped: the account changed.");
    this.name = "ShoppingSyncCancelledError";
  }
}

/** The last household check that answered: the account's household (null: none), and when. */
interface HouseholdCheck {
  checkedAt: number;
  id: string | null;
  userId: string;
}

/**
 * The same answer, due for a fresh check on the next pass. Its household stays known: the list
 * keeps showing it (a check failing offline doesn't change whose list this is), and a later
 * answer can tell that the account moved.
 */
const expired = (check: HouseholdCheck | null): HouseholdCheck | null =>
  check && { ...check, checkedAt: 0 };

interface SyncLoopState {
  loop: Promise<void> | null;
  pending: boolean;
  pendingPull: boolean;
}

export const ShoppingListProvider = ({ children }: PropsWithChildren) => {
  const { getAuthHeaders, isSignedIn, user } = useAccount();
  const [checkedHousehold, setCheckedHousehold] = useState<HouseholdCheck | null>(null);
  const [hasLoadedShoppingItems, setHasLoadedShoppingItems] = useState(false);
  const [isRefreshingShoppingList, setIsRefreshingShoppingList] = useState(false);
  const [shoppingError, setShoppingError] = useState<string | null>(null);
  const [shoppingItems, setShoppingItems] = useState<MobileShoppingItem[]>([]);
  const [hasUnreadableStoredItems, setHasUnreadableStoredItems] = useState(false);
  const shoppingItemsRef = useRef<MobileShoppingItem[]>([]);
  const householdCheckRef = useRef<HouseholdCheck | null>(null);
  /** Set while a sync pass runs: throws once the account it runs for is no longer signed in. */
  const syncPassGuardRef = useRef<(() => void) | null>(null);
  const syncLoopRef = useRef<SyncLoopState>({ loop: null, pending: false, pendingPull: false });
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const client = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        getHeaders: async () => {
          const headers = await getAuthHeaders();
          // Credentials can take a moment (a token refresh). A sync pass whose account signed
          // out meanwhile must not send its request with the next account's.
          syncPassGuardRef.current?.();
          return headers;
        }
      }),
    [getAuthHeaders]
  );
  /**
   * The household the list syncs with and shows: the signed-in account's, once a check for that
   * account has answered. A check that fails (offline) keeps the last answer.
   */
  const activeHouseholdId =
    isSignedIn && user && checkedHousehold?.userId === user.id ? checkedHousehold.id : null;
  const canSyncShoppingList = Boolean(isSignedIn && user && activeHouseholdId);
  const latestRef = useRef({
    canSyncShoppingList,
    client,
    hasLoadedShoppingItems,
    householdId: activeHouseholdId ?? undefined,
    isSignedIn,
    userId: user?.id
  });
  latestRef.current = {
    canSyncShoppingList,
    client,
    hasLoadedShoppingItems,
    householdId: activeHouseholdId ?? undefined,
    isSignedIn,
    userId: user?.id
  };
  const writer = useMemo(
    () =>
      createDebouncedWriter<MobileShoppingItem[]>(async (items) => {
        try {
          await AsyncStorage.setItem(SHOPPING_ITEMS_STORAGE_KEY, serializeShoppingItems(items));
        } catch (error) {
          console.warn("Failed to persist shopping list.", error);
        }
      }, SHOPPING_PERSIST_DEBOUNCE_MS),
    []
  );

  /**
   * Every list change goes through here. The ref is updated synchronously, so a sync pass or
   * a second mutation in the same tick always sees the latest items even before React renders.
   */
  const commitShoppingItems = useCallback(
    (update: (items: MobileShoppingItem[]) => MobileShoppingItem[]) => {
      shoppingItemsRef.current = update(shoppingItemsRef.current);
      setShoppingItems(shoppingItemsRef.current);
    },
    []
  );

  useEffect(() => {
    let isMounted = true;

    const hydrateShoppingItems = async () => {
      try {
        const storedItems = await AsyncStorage.getItem(SHOPPING_ITEMS_STORAGE_KEY);
        const { items, status } = readShoppingItems(storedItems);

        if (status === "corrupt") {
          console.warn("Shopping list could not be read. Keeping the stored copy for recovery.");
          setHasUnreadableStoredItems(true);

          try {
            await AsyncStorage.setItem(
              SHOPPING_ITEMS_CORRUPT_BACKUP_STORAGE_KEY,
              storedItems ?? ""
            );
          } catch (error) {
            console.warn("Failed to back up the unreadable shopping list.", error);
          }
        }

        if (!isMounted) {
          return;
        }

        commitShoppingItems(() => sortShoppingItems(items));
      } catch (error) {
        console.warn("Failed to load shopping list.", error);
      } finally {
        if (isMounted) {
          setHasLoadedShoppingItems(true);
        }
      }
    };

    void hydrateShoppingItems();

    return () => {
      isMounted = false;
    };
  }, [commitShoppingItems]);

  useEffect(() => {
    if (!hasLoadedShoppingItems) {
      return;
    }

    // The stored list could not be parsed. Writing an empty list over it now
    // would make a recoverable read failure permanent, so wait for real content.
    if (hasUnreadableStoredItems && shoppingItems.length === 0) {
      return;
    }

    writer.schedule(shoppingItems);
  }, [hasLoadedShoppingItems, hasUnreadableStoredItems, shoppingItems, writer]);

  /**
   * The household a pass syncs with: this account's cached answer, or a fresh check (always for
   * a pull). Unsent changes that don't name a household yet are recorded as this one's, and if
   * the account moved household, its changes for the old one move with it. Resolves null when
   * the account isn't in a household or the check failed (shown as the list's error).
   */
  const resolveHousehold = useCallback(
    async (
      apiClient: ExtractorApiClient,
      userId: string,
      pull: boolean,
      ensureCurrent: () => void
    ): Promise<string | null> => {
      const last = householdCheckRef.current?.userId === userId ? householdCheckRef.current : null;

      if (!pull && last?.id && Date.now() - last.checkedAt < HOUSEHOLD_ID_CACHE_MS) {
        const cachedId = last.id;
        commitShoppingItems((current) => claimShoppingChanges(current, cachedId));
        return cachedId;
      }

      let householdId: string | null;

      try {
        householdId = (await apiClient.getHousehold()).household?.id ?? null;
      } catch (error) {
        if (error instanceof ShoppingSyncCancelledError) {
          throw error;
        }

        householdCheckRef.current = expired(householdCheckRef.current);
        setShoppingError(getShoppingErrorMessage(error));
        return null;
      }

      // An answer that arrives after the account signed out is not the next account's.
      ensureCurrent();
      const check: HouseholdCheck = { checkedAt: Date.now(), id: householdId, userId };
      householdCheckRef.current = check;
      setCheckedHousehold(check);

      if (!householdId) {
        setShoppingError(null);
        return null;
      }

      const from = last?.id && last.id !== householdId ? last.id : undefined;
      commitShoppingItems((current) => claimShoppingChanges(current, householdId, { from }));
      return householdId;
    },
    [commitShoppingItems]
  );

  /**
   * Pushes this household's unsent changes (edits, then tombstones) and pulls when asked or when
   * needed. Another household's changes are not sent: they wait on this device, out of this
   * list, until that household syncs here again. Items the API refuses as another household's
   * (stored before items recorded their household) are set aside on this device instead.
   */
  const pushAndPull = useCallback(
    async (
      apiClient: ExtractorApiClient,
      householdId: string,
      pull: boolean,
      ensureCurrent: () => void
    ): Promise<void> => {
      const syncableDirtyItems = getPendingShoppingChanges(shoppingItemsRef.current, householdId);
      const dirtyUpserts = syncableDirtyItems.filter((item) => !item.isDeleted);
      const dirtyDeletes = syncableDirtyItems.filter((item) => item.isDeleted);

      if (!pull && syncableDirtyItems.length === 0) {
        return;
      }

      const pushedVersions = new Map(dirtyUpserts.map((item) => [item.id, item.updatedAt]));
      const failedIds = new Set(syncableDirtyItems.map((item) => item.id));

      try {
        const upserts = await sendIsolatingOtherHouseholdItems(dirtyUpserts, (batch) => {
          ensureCurrent();
          return apiClient.upsertShoppingItems({ items: batch.map(toApiShoppingItem) });
        });
        const deletes = await sendIsolatingOtherHouseholdItems(dirtyDeletes, (batch) => {
          ensureCurrent();
          return apiClient.deleteShoppingItems({
            items: batch.map((item) => ({
              id: item.id,
              updatedAt: item.updatedAt
            }))
          });
        });
        // Every upsert answers with the whole household list, so the last one is the newest.
        let remoteItems: ShoppingItem[] | null =
          upserts.results[upserts.results.length - 1]?.items ?? null;

        if (pull && remoteItems == null) {
          ensureCurrent();
          remoteItems = (await apiClient.getShoppingList()).items;
        }

        // Answers that arrive after the account signed out are not recorded as this household's.
        ensureCurrent();
        const syncedAt = new Date().toISOString();
        const deletedIds = new Set(deletes.results.flatMap((result) => result.deletedItemIds));
        const refusedIds = new Set([...upserts.refusedIds, ...deletes.refusedIds]);
        const remoteAfterDeletes = remoteItems?.filter((item) => !deletedIds.has(item.id)) ?? null;

        commitShoppingItems((current) => {
          const withoutDeleted = setAsideShoppingItems(current, refusedIds, householdId).filter(
            (item) => !deletedIds.has(item.id)
          );
          const marked = markShoppingItemsSynced(
            withoutDeleted,
            pushedVersions,
            syncedAt,
            householdId
          );
          return sortShoppingItems(
            remoteAfterDeletes
              ? applyRemoteShoppingItems(marked, remoteAfterDeletes, householdId)
              : marked
          );
        });
        setShoppingError(null);
      } catch (syncError) {
        if (syncError instanceof ShoppingSyncCancelledError) {
          throw syncError;
        }

        if (isHouseholdAccessError(syncError)) {
          householdCheckRef.current = expired(householdCheckRef.current);
        }

        const message = getShoppingErrorMessage(syncError);
        commitShoppingItems((current) => markShoppingItemsSyncFailed(current, failedIds, message));
        setShoppingError(message);
      }
    },
    [commitShoppingItems]
  );

  /**
   * One pass for the signed-in account: which household it is in, then that household's push and
   * pull. Passes run one at a time and each checks the household itself, so what can change under
   * a pass is the account. Once it has, the pass stops (ShoppingSyncCancelledError) before its
   * next request and before recording any answer, so nothing goes to or comes from the wrong
   * household; the loop then runs a pass for whoever is signed in.
   */
  const runSyncPass = useCallback(
    async (pull: boolean): Promise<void> => {
      const { client: apiClient, isSignedIn: signedIn, userId } = latestRef.current;

      if (!signedIn || !userId) {
        householdCheckRef.current = expired(householdCheckRef.current);
        setShoppingError(null);
        return;
      }

      const ensureCurrent = () => {
        const latest = latestRef.current;

        if (!latest.isSignedIn || latest.userId !== userId) {
          throw new ShoppingSyncCancelledError();
        }
      };
      syncPassGuardRef.current = ensureCurrent;

      try {
        const householdId = await resolveHousehold(apiClient, userId, pull, ensureCurrent);

        if (householdId) {
          await pushAndPull(apiClient, householdId, pull, ensureCurrent);
        }
      } finally {
        syncPassGuardRef.current = null;
      }
    },
    [pushAndPull, resolveHousehold]
  );

  /**
   * Runs sync passes one at a time. A request that arrives while a pass is in flight is not
   * dropped: it queues exactly one follow-up pass (which pulls if any queued request asked
   * to), so edits made during a refresh are pushed as soon as it finishes.
   */
  const requestSync = useCallback(
    (pull: boolean): Promise<void> => {
      const state = syncLoopRef.current;
      state.pending = true;
      state.pendingPull = state.pendingPull || pull;

      if (state.loop) {
        return state.loop;
      }

      state.loop = (async () => {
        try {
          while (state.pending) {
            const shouldPull = state.pendingPull;
            state.pending = false;
            state.pendingPull = false;

            try {
              await runSyncPass(shouldPull);
            } catch (error) {
              if (!(error instanceof ShoppingSyncCancelledError)) {
                throw error;
              }

              // It ran for an account that is no longer signed in: sync the one that is.
              state.pending = true;
              state.pendingPull = true;
            }
          }
        } finally {
          state.loop = null;
        }
      })();

      return state.loop;
    },
    [runSyncPass]
  );

  const clearScheduledSync = useCallback(() => {
    if (syncTimerRef.current != null) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  /** Coalesces a burst of mutations into one push. */
  const scheduleSync = useCallback(() => {
    clearScheduledSync();
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void requestSync(false);
    }, SHOPPING_SYNC_DEBOUNCE_MS);
  }, [clearScheduledSync, requestSync]);

  const refreshShoppingList = useCallback(async () => {
    if (!hasLoadedShoppingItems) {
      return;
    }

    if (!isSignedIn || !user) {
      householdCheckRef.current = expired(householdCheckRef.current);
      setShoppingError(null);
      return;
    }

    clearScheduledSync();
    setIsRefreshingShoppingList(true);

    try {
      await requestSync(true);
    } finally {
      setIsRefreshingShoppingList(false);
    }
  }, [clearScheduledSync, hasLoadedShoppingItems, isSignedIn, requestSync, user]);

  useEffect(() => {
    void refreshShoppingList();
  }, [refreshShoppingList]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshShoppingList();
        return;
      }

      // Leaving the foreground: write the list now and push any check-offs still waiting for
      // the debounce, so nothing is lost if the OS stops the app in the background.
      void writer.flush().catch(() => undefined);

      if (syncTimerRef.current != null) {
        clearScheduledSync();
        void requestSync(false);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [clearScheduledSync, refreshShoppingList, requestSync, writer]);

  useEffect(
    () => () => {
      clearScheduledSync();
      void writer.flush().catch(() => undefined);
    },
    [clearScheduledSync, writer]
  );

  const applyMutation = useCallback(
    (mutate: (items: MobileShoppingItem[]) => MobileShoppingItem[]) => {
      commitShoppingItems(mutate);

      if (latestRef.current.canSyncShoppingList) {
        scheduleSync();
      }
    },
    [commitShoppingItems, scheduleSync]
  );

  const addItems = useCallback(
    (inputs: AddShoppingItemInput[]) => {
      const filteredInputs = inputs.filter((input) => input.text.trim());

      if (filteredInputs.length === 0) {
        return;
      }

      const { canSyncShoppingList: canSync, householdId, userId } = latestRef.current;
      applyMutation((current) =>
        sortShoppingItems(
          addShoppingItemsToList(current, filteredInputs, { canSync, householdId, userId })
        )
      );

      trackMobileEvent({
        eventName: "shopping_item_added",
        routeOrScreen: "shopping",
        properties: {
          count: filteredInputs.length,
          recipeTagged: filteredInputs.some((input) => Boolean(input.recipeId))
        }
      });
    },
    [applyMutation]
  );

  const setItemChecked = useCallback(
    (id: string, checked: boolean) => {
      const { canSyncShoppingList: canSync, householdId, userId } = latestRef.current;
      applyMutation((current) =>
        setShoppingItemCheckedInList(current, id, checked, { canSync, householdId, userId })
      );

      if (checked) {
        trackMobileEvent({
          eventName: "shopping_item_checked",
          routeOrScreen: "shopping",
          properties: {
            itemId: id
          }
        });
      }
    },
    [applyMutation]
  );

  const deleteItem = useCallback(
    (id: string) => {
      const { canSyncShoppingList: canSync, householdId, userId } = latestRef.current;
      applyMutation((current) =>
        deleteShoppingItemInList(current, id, { canSync, householdId, userId })
      );
    },
    [applyMutation]
  );

  const clearCheckedItems = useCallback(() => {
    const { canSyncShoppingList: canSync, householdId, userId } = latestRef.current;
    applyMutation((current) =>
      clearCheckedShoppingItemsInList(current, { canSync, householdId, userId })
    );
  }, [applyMutation]);

  const visibleShoppingItems = useMemo(
    () => getShoppingListItems(shoppingItems, activeHouseholdId),
    [activeHouseholdId, shoppingItems]
  );

  const state = useMemo<ShoppingListState>(
    () => ({
      canSyncShoppingList,
      hasLoadedShoppingItems,
      isRefreshingShoppingList,
      shoppingError,
      shoppingItems: visibleShoppingItems
    }),
    [
      canSyncShoppingList,
      hasLoadedShoppingItems,
      isRefreshingShoppingList,
      shoppingError,
      visibleShoppingItems
    ]
  );

  const actions = useMemo<ShoppingListActions>(
    () => ({
      addItems,
      clearCheckedItems,
      deleteItem,
      refreshShoppingList,
      setItemChecked
    }),
    [addItems, clearCheckedItems, deleteItem, refreshShoppingList, setItemChecked]
  );

  return (
    <ShoppingListActionsContext.Provider value={actions}>
      <ShoppingListStateContext.Provider value={state}>
        {children}
      </ShoppingListStateContext.Provider>
    </ShoppingListActionsContext.Provider>
  );
};

/** Actions only: components that add or check items without rendering the list skip re-renders. */
export const useShoppingListActions = (): ShoppingListActions => {
  const actions = useContext(ShoppingListActionsContext);

  if (!actions) {
    throw new Error("useShoppingListActions must be used within ShoppingListProvider.");
  }

  return actions;
};

export const useShoppingList = (): ShoppingListContextValue => {
  const state = useContext(ShoppingListStateContext);
  const actions = useContext(ShoppingListActionsContext);
  const value = useMemo(
    () => (state && actions ? { ...state, ...actions } : null),
    [actions, state]
  );

  if (!value) {
    throw new Error("useShoppingList must be used within ShoppingListProvider.");
  }

  return value;
};
