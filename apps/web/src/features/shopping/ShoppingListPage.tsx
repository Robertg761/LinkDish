import React, { useCallback, useEffect, useMemo, useState } from "react";

import { trackWebEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { ErrorState } from "../../components/ErrorState";
import { Icon } from "../../components/Icon";

import {
  addShoppingItems,
  deleteShoppingItem,
  getShoppingItems,
  setShoppingItemChecked,
  shoppingTextFromQuantity,
  syncShoppingItems,
  type WebShoppingItem
} from "./shopping-list-store";

import "./ShoppingListPage.css";

type ShoppingSyncMode = "household" | "local";

const getRecipeMonogram = (title: string): string =>
  title
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "LD";

const getSyncLabel = (item: WebShoppingItem): string | null => {
  if (item.sync.status === "dirty") {
    return "Syncing";
  }

  if (item.sync.status === "sync_failed") {
    return "Offline";
  }

  return null;
};

export const ShoppingListPage: React.FC = () => {
  const { isAuthenticated, loading: authLoading, user } = useAuth();
  const [items, setItems] = useState<WebShoppingItem[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ShoppingSyncMode>("local");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cartExpanded, setCartExpanded] = useState(false);
  const [error, setError] = useState("");

  const canSync = mode === "household";

  const loadItems = useCallback(
    async (options: { sync?: boolean } = {}) => {
      if (authLoading) {
        return;
      }

      setError("");
      setRefreshing(Boolean(options.sync));

      try {
        let nextMode: ShoppingSyncMode = "local";

        if (isAuthenticated) {
          const householdResponse = await apiClient.getHousehold();
          nextMode = householdResponse.household ? "household" : "local";
        }

        setMode(nextMode);
        const nextItems =
          options.sync && nextMode === "household"
            ? await syncShoppingItems({ canSync: true })
            : await getShoppingItems();
        setItems(nextItems);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Shopping list failed to load.");
        setItems(await getShoppingItems());
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [authLoading, isAuthenticated]
  );

  useEffect(() => {
    void loadItems({ sync: true });
  }, [loadItems]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") {
        void loadItems({ sync: true });
      }
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);

    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [loadItems]);

  const activeItems = items.filter((item) => !item.checked);
  const checkedItems = items.filter((item) => item.checked);
  const isShoppingListEmpty = activeItems.length === 0 && checkedItems.length === 0;
  const groupedItems = useMemo(() => {
    const recipeGroups = new Map<string, WebShoppingItem[]>();
    const everythingElse: WebShoppingItem[] = [];

    activeItems.forEach((item) => {
      if (!item.recipeTitle) {
        everythingElse.push(item);
        return;
      }

      const key = `${item.recipeId ?? item.recipeTitle}::${item.recipeTitle}`;
      recipeGroups.set(key, [...(recipeGroups.get(key) ?? []), item]);
    });

    return {
      everythingElse,
      recipes: Array.from(recipeGroups.entries()).map(([key, recipeItems]) => ({
        key,
        recipeTitle: recipeItems[0]?.recipeTitle ?? "Recipe",
        items: recipeItems
      }))
    };
  }, [activeItems]);

  const refreshItems = async () => {
    await loadItems({ sync: true });
  };

  const addQuickItem = async (event: React.FormEvent) => {
    event.preventDefault();

    const text = input.trim();

    if (!text) {
      return;
    }

    const nextItems = await addShoppingItems([{ text }], { canSync, userId: user?.id });
    setInput("");
    setItems(nextItems);
    trackWebEvent({
      eventName: "shopping_item_added",
      routeOrScreen: "/shopping",
      properties: {
        count: 1,
        source: "quick_add"
      }
    });

    if (canSync) {
      void syncShoppingItems({ canSync: true }).then(setItems).catch(() => undefined);
    }
  };

  const toggleItem = async (item: WebShoppingItem) => {
    const updated = await setShoppingItemChecked(item.id, !item.checked, {
      canSync,
      userId: user?.id
    });

    if (!updated) {
      return;
    }

    setItems((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    trackWebEvent({
      eventName: "shopping_item_checked",
      routeOrScreen: "/shopping",
      properties: {
        checked: updated.checked
      }
    });

    if (canSync) {
      void syncShoppingItems({ canSync: true }).then(setItems).catch(() => undefined);
    }
  };

  const removeItem = async (item: WebShoppingItem) => {
    await deleteShoppingItem(item.id, { canSync });
    setItems(await getShoppingItems());

    if (canSync) {
      void syncShoppingItems({ canSync: true }).then(setItems).catch(() => undefined);
    }
  };

  const renderItem = (item: WebShoppingItem) => {
    const syncLabel = getSyncLabel(item);

    return (
      <div className={`shopping-item-row${item.checked ? " is-checked" : ""}`} key={item.id}>
        <button
          aria-checked={item.checked}
          className="shopping-item-toggle"
          onClick={() => {
            void toggleItem(item);
          }}
          role="checkbox"
          type="button"
        >
          <span className="shopping-item-check">
            {item.checked ? <Icon name="check" size={13} /> : null}
          </span>
          <span className="shopping-item-copy">
            <span className="shopping-item-text">
              {shoppingTextFromQuantity(item.qty, item.unit, item.text)}
            </span>
            {syncLabel ? <span className="shopping-item-sync">{syncLabel}</span> : null}
          </span>
        </button>
        <button
          aria-label={`Delete ${item.text}`}
          className="shopping-item-delete"
          onClick={() => {
            void removeItem(item);
          }}
          type="button"
        >
          <Icon name="trash-can-outline" size={18} />
        </button>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="shopping-page container page-enter">
        <p className="shopping-loading">Loading shopping list...</p>
      </div>
    );
  }

  return (
    <div className="shopping-page container page-enter">
      <header className="shopping-header">
        <div>
          <p className="shopping-eyebrow">Groceries</p>
          <h1>Shopping list</h1>
        </div>
        <Button variant="outline" onClick={refreshItems} loading={refreshing}>
          <Icon name="refresh" size={18} /> Refresh
        </Button>
      </header>

      {mode === "local" ? (
        <p className="shopping-local-note">Family syncs this list across the household.</p>
      ) : (
        <Chip variant="accent">Household sync on</Chip>
      )}

      {error ? <ErrorState message={error} /> : null}

      <form className="shopping-quick-add" onSubmit={addQuickItem}>
        <input
          aria-label="Add an item"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Add an item…"
          value={input}
        />
        <Button type="submit" disabled={!input.trim()}>
          Add
        </Button>
      </form>

      <div className="shopping-list-groups">
        {isShoppingListEmpty ? (
          <p className="shopping-empty-copy">
            Your shopping list is empty. Add ingredients from any recipe.
          </p>
        ) : (
          <>
            {groupedItems.recipes.map((group) => (
              <section className="shopping-recipe-group" key={group.key}>
                <div className="shopping-group-header">
                  <span className="shopping-recipe-avatar">
                    {getRecipeMonogram(group.recipeTitle)}
                  </span>
                  <h2>{group.recipeTitle}</h2>
                </div>
                <div className="shopping-group-items">{group.items.map(renderItem)}</div>
              </section>
            ))}

            <section className="shopping-recipe-group">
              <div className="shopping-group-header">
                <span className="shopping-recipe-avatar">+</span>
                <h2>Everything else</h2>
              </div>
              <div className="shopping-group-items">
                {groupedItems.everythingElse.length > 0 ? (
                  groupedItems.everythingElse.map(renderItem)
                ) : (
                  <p className="shopping-empty-copy">Your loose items will live here.</p>
                )}
              </div>
            </section>
          </>
        )}

        <section className="shopping-cart-section">
          <button
            aria-expanded={cartExpanded}
            className="shopping-cart-toggle"
            onClick={() => setCartExpanded((expanded) => !expanded)}
            type="button"
          >
            <span>In the cart</span>
            <span className="shopping-cart-count">{checkedItems.length}</span>
            <Icon name={cartExpanded ? "chevron-up" : "chevron-down"} size={20} />
          </button>
          {cartExpanded ? (
            <div className="shopping-group-items">
              {checkedItems.length > 0 ? (
                checkedItems.map(renderItem)
              ) : (
                <p className="shopping-empty-copy">Checked items will sink here.</p>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
