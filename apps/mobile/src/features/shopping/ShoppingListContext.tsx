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
import { useAccount } from "../account/AccountContext";

import {
  addShoppingItemsToList,
  applyRemoteShoppingItems,
  deleteShoppingItemInList,
  markShoppingItemsSyncFailed,
  parseShoppingItems,
  serializeShoppingItems,
  setShoppingItemCheckedInList,
  sortShoppingItems,
  toApiShoppingItem,
  type AddShoppingItemInput,
  type MobileShoppingItem
} from "./store";

const SHOPPING_ITEMS_STORAGE_KEY = "linkdish.shoppingItems.v1";

interface ShoppingListContextValue {
  addItems: (inputs: AddShoppingItemInput[]) => void;
  canSyncShoppingList: boolean;
  deleteItem: (id: string) => void;
  hasLoadedShoppingItems: boolean;
  isRefreshingShoppingList: boolean;
  refreshShoppingList: () => Promise<void>;
  setItemChecked: (id: string, checked: boolean) => void;
  shoppingError: string | null;
  shoppingItems: MobileShoppingItem[];
}

const ShoppingListContext = createContext<ShoppingListContextValue | null>(null);

const getShoppingErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "Shopping list sync failed.";
};

const getSyncableDirtyItems = (items: MobileShoppingItem[]): MobileShoppingItem[] =>
  items.filter(
    (item) =>
      item.sync.status !== "local_only" &&
      (item.sync.status === "dirty" || item.sync.status === "sync_failed")
  );

export const ShoppingListProvider = ({ children }: PropsWithChildren) => {
  const { getAuthHeaders, isSignedIn, user } = useAccount();
  const [activeHouseholdId, setActiveHouseholdId] = useState<string | null>(null);
  const [hasLoadedShoppingItems, setHasLoadedShoppingItems] = useState(false);
  const [isRefreshingShoppingList, setIsRefreshingShoppingList] = useState(false);
  const [shoppingError, setShoppingError] = useState<string | null>(null);
  const [shoppingItems, setShoppingItems] = useState<MobileShoppingItem[]>([]);
  const isRefreshingRef = useRef(false);
  const shoppingItemsRef = useRef<MobileShoppingItem[]>([]);
  const client = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        getHeaders: getAuthHeaders
      }),
    [getAuthHeaders]
  );
  const canSyncShoppingList = Boolean(isSignedIn && user && activeHouseholdId);

  useEffect(() => {
    shoppingItemsRef.current = shoppingItems;
  }, [shoppingItems]);

  useEffect(() => {
    let isMounted = true;

    const hydrateShoppingItems = async () => {
      try {
        const storedItems = await AsyncStorage.getItem(SHOPPING_ITEMS_STORAGE_KEY);

        if (!isMounted) {
          return;
        }

        setShoppingItems(sortShoppingItems(parseShoppingItems(storedItems)));
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
  }, []);

  useEffect(() => {
    if (!hasLoadedShoppingItems) {
      return;
    }

    const persistShoppingItems = async () => {
      try {
        await AsyncStorage.setItem(SHOPPING_ITEMS_STORAGE_KEY, serializeShoppingItems(shoppingItems));
      } catch (error) {
        console.warn("Failed to persist shopping list.", error);
      }
    };

    void persistShoppingItems();
  }, [hasLoadedShoppingItems, shoppingItems]);

  const refreshShoppingList = useCallback(async () => {
    if (!hasLoadedShoppingItems || isRefreshingRef.current) {
      return;
    }

    if (!isSignedIn || !user) {
      setActiveHouseholdId(null);
      setShoppingError(null);
      return;
    }

    isRefreshingRef.current = true;
    setIsRefreshingShoppingList(true);

    try {
      const householdResponse = await client.getHousehold();
      const householdId = householdResponse.household?.id ?? null;
      setActiveHouseholdId(householdId);

      if (!householdId) {
        setShoppingError(null);
        return;
      }

      const syncableDirtyItems = getSyncableDirtyItems(shoppingItemsRef.current);
      const dirtyUpserts = syncableDirtyItems.filter((item) => !item.isDeleted);
      const dirtyDeletes = syncableDirtyItems.filter((item) => item.isDeleted);
      const failedIds = new Set(syncableDirtyItems.map((item) => item.id));

      try {
        if (dirtyUpserts.length > 0) {
          await client.upsertShoppingItems({
            items: dirtyUpserts.map(toApiShoppingItem)
          });
        }

        let deletedItemIds: string[] = [];
        if (dirtyDeletes.length > 0) {
          const deleted = await client.deleteShoppingItems({
            items: dirtyDeletes.map((item) => ({
              id: item.id,
              updatedAt: item.updatedAt
            }))
          });
          deletedItemIds = deleted.deletedItemIds;
        }

        const response = await client.getShoppingList();
        setShoppingItems((current) =>
          sortShoppingItems(
            applyRemoteShoppingItems(
              current.filter((item) => !deletedItemIds.includes(item.id)),
              response.items
            )
          )
        );
        setShoppingError(null);
      } catch (syncError) {
        const message = getShoppingErrorMessage(syncError);
        setShoppingItems((current) => markShoppingItemsSyncFailed(current, failedIds, message));
        setShoppingError(message);
      }
    } catch (error) {
      setActiveHouseholdId(null);
      setShoppingError(getShoppingErrorMessage(error));
    } finally {
      isRefreshingRef.current = false;
      setIsRefreshingShoppingList(false);
    }
  }, [client, hasLoadedShoppingItems, isSignedIn, user]);

  useEffect(() => {
    void refreshShoppingList();
  }, [refreshShoppingList]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refreshShoppingList();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [refreshShoppingList]);

  const addItems = (inputs: AddShoppingItemInput[]) => {
    const filteredInputs = inputs.filter((input) => input.text.trim());

    if (filteredInputs.length === 0) {
      return;
    }

    setShoppingItems((current) =>
      sortShoppingItems(
        addShoppingItemsToList(current, filteredInputs, {
          canSync: canSyncShoppingList,
          userId: user?.id
        })
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

    if (canSyncShoppingList) {
      setTimeout(() => {
        void refreshShoppingList();
      }, 0);
    }
  };

  const setItemChecked = (id: string, checked: boolean) => {
    setShoppingItems((current) =>
      setShoppingItemCheckedInList(current, id, checked, {
        canSync: canSyncShoppingList,
        userId: user?.id
      })
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

    if (canSyncShoppingList) {
      setTimeout(() => {
        void refreshShoppingList();
      }, 0);
    }
  };

  const deleteItem = (id: string) => {
    setShoppingItems((current) =>
      deleteShoppingItemInList(current, id, {
        canSync: canSyncShoppingList,
        userId: user?.id
      })
    );

    if (canSyncShoppingList) {
      setTimeout(() => {
        void refreshShoppingList();
      }, 0);
    }
  };

  return (
    <ShoppingListContext.Provider
      value={{
        addItems,
        canSyncShoppingList,
        deleteItem,
        hasLoadedShoppingItems,
        isRefreshingShoppingList,
        refreshShoppingList,
        setItemChecked,
        shoppingError,
        shoppingItems: shoppingItems.filter((item) => !item.isDeleted)
      }}
    >
      {children}
    </ShoppingListContext.Provider>
  );
};

export const useShoppingList = () => {
  const context = useContext(ShoppingListContext);

  if (!context) {
    throw new Error("useShoppingList must be used within ShoppingListProvider.");
  }

  return context;
};
