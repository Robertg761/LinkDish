import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { Button, ButtonLink } from "../../components/Button";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import { PageHeader } from "../../components/PageHeader";
import { RecipeImage } from "../../components/RecipeImage";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useToast } from "../../components/Toast";
import { useSavedRecipe } from "../../data/library-store";

import { AisleIcon } from "./AisleIcon";
import {
  ADDED_BY_YOU_GROUP_ID,
  buildShoppingShareText,
  formatItemAmount,
  groupItemsByAisle,
  groupItemsByRecipe,
  isStapleItem,
  openItemKeys,
  readHideStaples,
  readShoppingView,
  recordShoppingHistory,
  writeHideStaples,
  writeShoppingView,
  type ShoppingAisleGroup,
  type ShoppingRecipeGroup,
  type ShoppingView
} from "./shopping-format";
import {
  addParsedShoppingItems,
  clearAllShoppingItems,
  clearCheckedShoppingItems,
  deleteShoppingItems,
  loadShoppingList,
  parseManualShoppingLine,
  restoreShoppingItems,
  setShoppingItemChecked,
  updateShoppingItemFromLine,
  useShoppingList,
  type ParsedShoppingItemInput,
  type WebShoppingItem
} from "./shopping-list-store";
import {
  getShoppingWriteOptions,
  requestShoppingSync,
  syncShoppingNow,
  useShoppingSync
} from "./shopping-sync";
import { ShoppingAddBar } from "./ShoppingAddBar";
import { ShoppingItemRow } from "./ShoppingItemRow";
import { ShoppingItemSheet } from "./ShoppingItemSheet";
import { ShoppingSyncStatus } from "./ShoppingSyncStatus";

import type { ShoppingAddMethod } from "./ShoppingAddBar";
import type { MenuEntry } from "../../components/Menu";

import "./ShoppingListPage.css";

const VIEW_OPTIONS = [
  { icon: "shopping-basket", label: "By aisle", value: "aisle" },
  { icon: "book-open", label: "By recipe", value: "recipe" }
] as const;

/** Undo window after a delete, so a quick Undo never round-trips the household. */
const DELETE_SYNC_DELAY_MS = 7_000;
const CHECK_LINGER_MS = 650;

/**
 * Before a row leaves the list (into the cart, or removed), where keyboard focus should go: the
 * next item's checkbox, else the previous one, else the cart toggle. Null when focus isn't in the
 * row, so nothing is moved for pointer users.
 */
const findFocusAfterLeaving = (itemId: string): HTMLElement | null => {
  const active = document.activeElement;
  const row = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-item-id]") : null;

  if (!row || row.dataset.itemId !== itemId) {
    return null;
  }

  const checks = Array.from(
    document.querySelectorAll<HTMLElement>(".shopping-groups [data-item-id] .shopping-row-check")
  );
  const position = checks.findIndex((check) => row.contains(check));
  const differentItem = (check: HTMLElement) =>
    check.closest<HTMLElement>("[data-item-id]")?.dataset.itemId !== itemId;

  return (
    checks.slice(position + 1).find(differentItem) ??
    checks.slice(0, Math.max(0, position)).reverse().find(differentItem) ??
    document.querySelector<HTMLElement>(".shopping-cart-toggle") ??
    document.querySelector<HTMLElement>(".shopping-add-input")
  );
};
const ENTER_ANIMATION_MS = 900;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const RecipeGroupHeading: React.FC<{ group: ShoppingRecipeGroup; headingId: string }> = ({
  group,
  headingId
}) => {
  const { recipe } = useSavedRecipe(group.recipeId);

  if (group.id === ADDED_BY_YOU_GROUP_ID) {
    return (
      <h2 className="shopping-group-title" id={headingId}>
        <span aria-hidden="true" className="shopping-group-icon">
          <Icon name="pencil" size={18} />
        </span>
        <span className="shopping-group-label">{group.label}</span>
        <span className="shopping-group-count num">{group.items.length}</span>
      </h2>
    );
  }

  const thumb = (
    <RecipeImage
      aspectRatio="1"
      className="shopping-group-thumb"
      image={recipe?.recipe.image}
      sizes="44px"
      title={group.label}
      widths={[96]}
    />
  );

  return (
    <h2 className="shopping-group-title is-recipe" id={headingId}>
      {thumb}
      {recipe ? (
        <Link className="shopping-group-label shopping-group-link" to={`/recipes/${recipe.id}`}>
          {group.label}
        </Link>
      ) : (
        <span className="shopping-group-label">{group.label}</span>
      )}
      <span className="shopping-group-count num">{group.items.length}</span>
    </h2>
  );
};

/**
 * /shopping — the list itself: renders from IndexedDB right away, groups by aisle (store-walk
 * order) or by recipe, checks items off into "In the cart", and keeps a household copy in sync
 * in the background.
 */
export const ShoppingListPage: React.FC = () => {
  const sync = useShoppingSync();
  const { items, status, error, retry } = useShoppingListView();
  const { showToast } = useToast();
  const [view, setView] = useState<ShoppingView>(readShoppingView);
  const [hideStaples, setHideStaples] = useState<boolean>(readHideStaples);
  const [cartOpen, setCartOpen] = useState(false);
  const [editing, setEditing] = useState<WebShoppingItem | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  const [historyVersion, setHistoryVersion] = useState(0);
  /** Polite announcements for moves screen readers can't see ("Lemons moved to the cart"). */
  const [announcement, setAnnouncement] = useState("");
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const checkingRef = useRef(checking);
  checkingRef.current = checking;

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const later = useCallback((run: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, delay);
    timers.current.add(timer);
  }, []);

  const flashEntering = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0 || prefersReducedMotion()) {
        return;
      }

      setEntering((current) => new Set([...current, ...ids]));
      later(() => {
        setEntering((current) => {
          const next = new Set(current);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }, ENTER_ANIMATION_MS);
    },
    [later]
  );

  const stapleIds = useMemo(
    () => new Set(items.filter((item) => isStapleItem(item)).map((item) => item.id)),
    [items]
  );
  const openItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (!item.checked || checking.has(item.id)) && !(hideStaples && stapleIds.has(item.id))
      ),
    [checking, hideStaples, items, stapleIds]
  );
  const cartItems = useMemo(
    () => items.filter((item) => item.checked && !checking.has(item.id)),
    [checking, items]
  );
  const hiddenStapleCount = hideStaples
    ? items.filter((item) => !item.checked && stapleIds.has(item.id)).length
    : 0;
  const toBuyCount = openItems.filter((item) => !checking.has(item.id)).length;
  const excludeKeys = useMemo(() => openItemKeys(items), [items]);
  const groups = useMemo<Array<ShoppingAisleGroup | ShoppingRecipeGroup>>(
    () => (view === "aisle" ? groupItemsByAisle(openItems) : groupItemsByRecipe(openItems)),
    [openItems, view]
  );
  const isEmpty = status !== "loading" && items.length === 0;

  const showError = useCallback(
    (cause: unknown) => {
      showToast({
        id: "shopping-error",
        message: getFriendlyErrorMessage(cause, "shopping"),
        tone: "danger"
      });
    },
    [showToast]
  );

  const handleAdd = useCallback(
    async (lines: string[], method: ShoppingAddMethod) => {
      const parsed: ParsedShoppingItemInput[] = lines.flatMap((line) => {
        const item = parseManualShoppingLine(line);
        return item ? [item] : [];
      });

      if (parsed.length === 0) {
        return;
      }

      try {
        const result = await addParsedShoppingItems(parsed, getShoppingWriteOptions());
        recordShoppingHistory(parsed.map((line) => line.text));
        setHistoryVersion((version) => version + 1);
        requestShoppingSync();
        flashEntering(result.changed.map((item) => item.id));
        trackWebEvent({
          eventName: "shopping_item_added",
          properties: { count: parsed.length, method, source: "manual" },
          routeOrScreen: "/shopping"
        });

        const hiddenAdded = hideStaples && result.changed.some((item) => isStapleItem(item));

        if (hiddenAdded) {
          showToast({
            action: {
              label: "Show staples",
              onClick: () => {
                setHideStaples(false);
                writeHideStaples(false);
              }
            },
            id: "shopping-added",
            message: "Added. Pantry staples are hidden right now.",
            tone: "success"
          });
        } else if (parsed.length > 1) {
          showToast({
            id: "shopping-added",
            message:
              result.mergedCount > 0
                ? `Added ${plural(parsed.length, "item", "items")} · ${result.mergedCount} combined`
                : `Added ${plural(parsed.length, "item", "items")}`,
            tone: "success"
          });
        }
      } catch (addError) {
        showError(addError);
      }
    },
    [flashEntering, hideStaples, showError, showToast]
  );

  const handleToggle = useCallback(
    (item: WebShoppingItem) => {
      const isChecking = checkingRef.current.has(item.id);
      const nextChecked = isChecking ? false : !item.checked;

      if (nextChecked) {
        setChecking((current) => new Set([...current, item.id]));
        later(
          () => {
            // Keep keyboard and screen reader users in place: focus moves to the next item
            // before this row leaves for the (collapsed) cart.
            if (checkingRef.current.has(item.id)) {
              findFocusAfterLeaving(item.id)?.focus();
              const amount = formatItemAmount(item);
              setAnnouncement(`${amount ? `${amount} ` : ""}${item.text} moved to the cart`);
            }

            setChecking((current) => {
              if (!current.has(item.id)) {
                return current;
              }

              const next = new Set(current);
              next.delete(item.id);
              return next;
            });
          },
          prefersReducedMotion() ? 120 : CHECK_LINGER_MS
        );
      } else {
        setChecking((current) => {
          if (!current.has(item.id)) {
            return current;
          }

          const next = new Set(current);
          next.delete(item.id);
          return next;
        });

        if (item.checked) {
          flashEntering([item.id]);
        }
      }

      setShoppingItemChecked(item.id, nextChecked, getShoppingWriteOptions()).then(
        () => {
          requestShoppingSync();

          if (nextChecked) {
            recordShoppingHistory([item.text]);
          }

          trackWebEvent({
            eventName: "shopping_item_checked",
            properties: { checked: nextChecked, source: item.recipeId ? "recipe" : "manual" },
            routeOrScreen: "/shopping"
          });
        },
        (toggleError: unknown) => {
          setChecking((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          });
          showError(toggleError);
        }
      );
    },
    [flashEntering, later, showError]
  );

  const restore = useCallback(
    async (records: WebShoppingItem[]) => {
      try {
        const restored = await restoreShoppingItems(records);
        requestShoppingSync();
        flashEntering(restored.filter((item) => !item.checked).map((item) => item.id));
      } catch (restoreError) {
        showError(restoreError);
      }
    },
    [flashEntering, showError]
  );

  const removeItems = useCallback(
    async (ids: string[], message: (count: number) => string) => {
      try {
        const removed = await deleteShoppingItems(ids, getShoppingWriteOptions());

        if (removed.length === 0) {
          return;
        }

        requestShoppingSync({ delayMs: DELETE_SYNC_DELAY_MS });
        showToast({
          action: { label: "Undo", onClick: () => void restore(removed) },
          icon: "trash",
          id: "shopping-removed",
          message: message(removed.length)
        });
      } catch (removeError) {
        showError(removeError);
      }
    },
    [restore, showError, showToast]
  );

  const handleRemove = useCallback(
    (item: WebShoppingItem) => {
      findFocusAfterLeaving(item.id)?.focus();
      void removeItems([item.id], () => `Removed ${item.text}`);
    },
    [removeItems]
  );

  const handleEdit = useCallback((item: WebShoppingItem) => setEditing(item), []);

  const saveEdit = async (item: WebShoppingItem, line: string) => {
    setEditing(null);

    try {
      await updateShoppingItemFromLine(item.id, line, getShoppingWriteOptions());
      requestShoppingSync();
    } catch (editError) {
      showError(editError);
    }
  };

  const clearCart = async () => {
    try {
      const removed = await clearCheckedShoppingItems(getShoppingWriteOptions());

      if (removed.length > 0) {
        requestShoppingSync({ delayMs: DELETE_SYNC_DELAY_MS });
        showToast({
          action: { label: "Undo", onClick: () => void restore(removed) },
          icon: "check-check",
          id: "shopping-removed",
          message: `Cleared ${plural(removed.length, "item", "items")} from the cart`
        });
      }
    } catch (clearError) {
      showError(clearError);
    }
  };

  const clearAll = async () => {
    setConfirmClearAll(false);

    try {
      const removed = await clearAllShoppingItems(getShoppingWriteOptions());

      if (removed.length > 0) {
        requestShoppingSync({ delayMs: DELETE_SYNC_DELAY_MS });
        showToast({
          action: { label: "Undo", onClick: () => void restore(removed) },
          icon: "trash",
          id: "shopping-removed",
          message: "Your list is clear"
        });
      }
    } catch (clearError) {
      showError(clearError);
    }
  };

  const shareList = async () => {
    const text = buildShoppingShareText(openItems);
    const itemCount = openItems.length;
    const track = (method: "share" | "copy") =>
      trackWebEvent({
        eventName: "shopping_list_shared",
        properties: { item_count: itemCount, method },
        routeOrScreen: "/shopping"
      });

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text, title: "Shopping list" });
        track("share");
        return;
      } catch (shareError) {
        if ((shareError as { name?: string } | null)?.name === "AbortError") {
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      track("copy");
      showToast({
        icon: "copy",
        id: "shopping-shared",
        message: "List copied. Paste it anywhere.",
        tone: "success"
      });
    } catch {
      showToast({
        id: "shopping-shared",
        message: "We couldn't copy the list. Try Print instead.",
        tone: "danger"
      });
    }
  };

  const toggleStaples = () => {
    setHideStaples((current) => {
      writeHideStaples(!current);
      return !current;
    });
  };

  const changeView = (next: ShoppingView) => {
    setView(next);
    writeShoppingView(next);
  };

  const menuItems: MenuEntry[] = [
    { id: "group-share", label: "Share & print", type: "separator" },
    {
      disabled: toBuyCount === 0,
      icon: "share-up",
      id: "share",
      label: "Share list",
      onSelect: () => void shareList()
    },
    { icon: "printer", id: "print", label: "Print", onSelect: () => window.print() },
    { id: "group-view", type: "separator" },
    {
      description: "Salt, pepper, water and friends",
      icon: hideStaples ? "eye" : "eye-off",
      id: "staples",
      label: hideStaples ? "Show pantry staples" : "Hide pantry staples",
      onSelect: toggleStaples
    },
    { id: "separator", type: "separator" },
    {
      disabled: cartItems.length === 0,
      icon: "check-check",
      id: "clear-checked",
      label: "Clear the cart",
      onSelect: () => void clearCart()
    },
    {
      disabled: items.length === 0,
      icon: "trash",
      id: "clear-all",
      label: "Clear all",
      onSelect: () => setConfirmClearAll(true),
      tone: "danger"
    }
  ];

  // Empty: the card below says so; the header doesn't repeat it.
  const subtitle = isEmpty
    ? "For this week's cooking."
    : status === "loading" && items.length === 0
      ? " "
      : toBuyCount === 0
        ? `All done · ${plural(cartItems.length, "item", "items")} in the cart`
        : `${toBuyCount} to buy${cartItems.length > 0 ? ` · ${cartItems.length} in the cart` : ""}`;

  const renderRows = (list: readonly WebShoppingItem[], groupRecipe?: string) =>
    list.map((item) => (
      <ShoppingItemRow
        checking={checking.has(item.id)}
        entering={entering.has(item.id)}
        groupRecipe={groupRecipe}
        item={item}
        key={item.id}
        onEdit={handleEdit}
        onRemove={handleRemove}
        onToggle={handleToggle}
      />
    ));

  return (
    <div className="shopping-page page-enter">
      <div className="shopping-header">
        <PageHeader accent="list" eyebrow="Groceries" subtitle={subtitle} title="Shopping" />
        <div className="shopping-header-menu">
          <Menu
            items={menuItems}
            label="List options"
            presentation="adaptive"
            sheetTitle="Shopping list"
            renderTrigger={(props) => (
              <IconButton
                aria-label="List options"
                icon="more-horizontal"
                variant="outline"
                {...props}
              />
            )}
          />
        </div>
      </div>

      <ShoppingSyncStatus
        onRetry={() => void syncShoppingNow()}
        signedIn={Boolean(sync.userId)}
        sync={sync}
      />

      <div className="shopping-toolbar">
        <ShoppingAddBar
          alwaysShowSuggestions={isEmpty}
          excludeKeys={excludeKeys}
          historyVersion={historyVersion}
          onAdd={(lines, method) => void handleAdd(lines, method)}
        />
      </div>

      {status === "error" && items.length === 0 ? (
        <div className="shopping-load-error" role="alert">
          <p>{getFriendlyErrorMessage(error, "load")}</p>
          <Button icon="refresh" onClick={retry} size="sm" variant="secondary">
            Try again
          </Button>
        </div>
      ) : null}

      {isEmpty && status === "ready" ? (
        <div className="shopping-empty">
          <EmptyState
            actions={
              <>
                <ButtonLink icon="book-open" to="/">
                  Add from a recipe
                </ButtonLink>
                <ButtonLink icon="calendar" to="/plan" variant="secondary">
                  Plan your week
                </ButtonLink>
              </>
            }
            body="Type what you need above, paste a whole list, or pull ingredients straight from a recipe. We'll sort it by aisle for you."
            illustration="basket"
            title="Your basket is empty"
          />
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <div className="shopping-view-row">
            <SegmentedControl
              aria-label="Group items"
              onChange={changeView}
              options={VIEW_OPTIONS}
              size="sm"
              value={view}
            />
            {hiddenStapleCount > 0 ? (
              <button className="shopping-staples-note" onClick={toggleStaples} type="button">
                <Icon name="eye-off" size={14} />
                {plural(hiddenStapleCount, "staple", "staples")} hidden · Show
              </button>
            ) : null}
          </div>

          {toBuyCount === 0 && checking.size === 0 ? (
            <div className="shopping-done">
              <span aria-hidden="true" className="shopping-done-icon">
                <Icon name="party-popper" size={22} />
              </span>
              <div>
                <p className="shopping-done-title">Everything's in the cart</p>
                <p className="shopping-done-body">
                  Nice shopping. Clear the cart when you're home.
                </p>
              </div>
              <Button onClick={() => void clearCart()} size="sm" variant="tonal">
                Clear the cart
              </Button>
            </div>
          ) : null}

          <div className={`shopping-groups is-${view}`}>
            {groups.map((group) => {
              const headingId = `shopping-group-${group.kind}-${group.id}`.replace(
                /[^a-z0-9-]/giu,
                "-"
              );

              return (
                <section
                  aria-labelledby={headingId}
                  className="shopping-group"
                  key={`${group.kind}-${group.id}`}
                >
                  {group.kind === "aisle" ? (
                    <h2 className="shopping-group-title" id={headingId}>
                      <span aria-hidden="true" className={`shopping-group-icon is-${group.id}`}>
                        <AisleIcon category={group.id} size={18} />
                      </span>
                      <span className="shopping-group-label">{group.label}</span>
                      <span className="shopping-group-count num">{group.items.length}</span>
                    </h2>
                  ) : (
                    <RecipeGroupHeading group={group} headingId={headingId} />
                  )}
                  <ul className="shopping-group-items">
                    {renderRows(group.items, group.kind === "recipe" ? group.label : undefined)}
                  </ul>
                </section>
              );
            })}
          </div>

          {cartItems.length > 0 ? (
            <section aria-label="In the cart" className="shopping-cart">
              <div className="shopping-cart-header">
                <button
                  aria-expanded={cartOpen}
                  className="shopping-cart-toggle"
                  onClick={() => setCartOpen((current) => !current)}
                  type="button"
                >
                  <span aria-hidden="true" className="shopping-cart-icon">
                    <Icon name="shopping-cart" size={18} />
                  </span>
                  <span className="shopping-cart-title">In the cart</span>
                  <span className="shopping-cart-count num">{cartItems.length}</span>
                  <Icon
                    className="shopping-cart-chevron"
                    name={cartOpen ? "chevron-up" : "chevron-down"}
                    size={20}
                  />
                </button>
                <Button onClick={() => void clearCart()} size="sm" variant="ghost">
                  Clear
                </Button>
              </div>
              {cartOpen ? (
                <ul className="shopping-group-items is-cart">{renderRows(cartItems)}</ul>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>

      <ShoppingItemSheet
        item={editing}
        onClose={() => setEditing(null)}
        onRemove={(item) => {
          setEditing(null);
          handleRemove(item);
        }}
        onSave={(item, line) => void saveEdit(item, line)}
      />

      <ConfirmationDialog
        confirmLabel="Clear all"
        message="Everything on the list goes, including the cart. You can undo right after."
        onCancel={() => setConfirmClearAll(false)}
        onConfirm={() => void clearAll()}
        title="Clear the whole list?"
        visible={confirmClearAll}
      />
    </div>
  );
};

/** The live list plus a retry for the (rare) IndexedDB failure. */
function useShoppingListView() {
  const snapshot = useShoppingList();
  const retry = useCallback(() => {
    void loadShoppingList({ force: true });
  }, []);

  return { ...snapshot, retry };
}
