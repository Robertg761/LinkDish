import {
  canonicalIngredientKey,
  formatShoppingItemText,
  groupByShoppingCategory,
  isPantryStaple
} from "@linkdish/recipe-domain";

import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import { getItemRecipeIds, getItemRecipeTitles } from "./shopping-list-store";

import type { WebShoppingItem } from "./shopping-list-store";
import type { ShoppingCategoryId } from "@linkdish/recipe-domain";

/** Display helpers for the shopping list: grouping, share text, quick-add history, settings. */

export const formatItem = (item: Pick<WebShoppingItem, "qty" | "text" | "unit">): string =>
  formatShoppingItemText(item);

/** The amount alone ("⅔ cup", "3"), or "" when the item has none. */
export const formatItemAmount = (item: Pick<WebShoppingItem, "qty" | "text" | "unit">): string => {
  const full = formatShoppingItemText(item);
  const name = item.text.trim();
  return full.endsWith(name) ? full.slice(0, full.length - name.length).trim() : "";
};

export const isStapleItem = (item: Pick<WebShoppingItem, "text">): boolean =>
  isPantryStaple(item.text);

export interface ShoppingAisleGroup {
  kind: "aisle";
  id: ShoppingCategoryId;
  label: string;
  items: WebShoppingItem[];
}

export interface ShoppingRecipeGroup {
  kind: "recipe";
  id: string;
  label: string;
  recipeId?: string | undefined;
  items: WebShoppingItem[];
}

/** Items by aisle in store-walk order (produce first), keeping list order inside an aisle. */
export const groupItemsByAisle = (items: readonly WebShoppingItem[]): ShoppingAisleGroup[] =>
  groupByShoppingCategory(items, formatItem).map((group) => ({
    id: group.category,
    items: group.items,
    kind: "aisle",
    label: group.label
  }));

export const ADDED_BY_YOU_GROUP_ID = "added-by-you";

/**
 * Items by the first recipe they came from (in the order recipes first appear), with items added
 * by hand last.
 */
/**
 * Items grouped under each recipe they are for. A merged item (butter for the cookies and the
 * banana bread) shows under every one of its recipes, so each group lists all its ingredients.
 */
export const groupItemsByRecipe = (items: readonly WebShoppingItem[]): ShoppingRecipeGroup[] => {
  const groups = new Map<string, ShoppingRecipeGroup>();
  const loose: WebShoppingItem[] = [];

  for (const item of items) {
    const titles = getItemRecipeTitles(item);
    const ids = getItemRecipeIds(item);

    if (titles.length === 0) {
      loose.push(item);
      continue;
    }

    titles.forEach((title, index) => {
      const recipeId = ids[index];
      const key = `${recipeId ?? ""}::${title}`;
      const group = groups.get(key);

      if (group) {
        if (!group.items.includes(item)) {
          group.items.push(item);
        }
      } else {
        groups.set(key, { id: key, items: [item], kind: "recipe", label: title, recipeId });
      }
    });
  }

  const result = Array.from(groups.values());

  if (loose.length > 0) {
    result.push({ id: ADDED_BY_YOU_GROUP_ID, items: loose, kind: "recipe", label: "Added by you" });
  }

  return result;
};

/**
 * Plain text for sharing or copying: what's still to buy, grouped by aisle.
 *
 *   Shopping list
 *
 *   Produce
 *   • 2 onions
 */
export const buildShoppingShareText = (
  items: readonly WebShoppingItem[],
  options: { title?: string | undefined } = {}
): string => {
  const open = items.filter((item) => !item.checked);
  const title = options.title ?? "Shopping list";

  if (open.length === 0) {
    return `${title}\n\nAll done. Nothing left to buy.`;
  }

  const sections = groupItemsByAisle(open).map(
    (group) => `${group.label}\n${group.items.map((item) => `• ${formatItem(item)}`).join("\n")}`
  );

  return `${title}\n\n${sections.join("\n\n")}\n`;
};

/* ------------------------------------------------------------------------------------------ */
/* Quick-add history ("buy again")                                                             */
/* ------------------------------------------------------------------------------------------ */

export const SHOPPING_HISTORY_KEY = "linkdish:web:shopping-history:v1";
const MAX_HISTORY = 80;

interface HistoryEntry {
  key: string;
  text: string;
  count: number;
  lastUsedAt: number;
}

const DEFAULT_SUGGESTIONS = [
  "Milk",
  "Eggs",
  "Bread",
  "Bananas",
  "Butter",
  "Onions",
  "Garlic",
  "Lemons",
  "Olive oil",
  "Coffee",
  "Rice",
  "Tomatoes",
  "Yogurt",
  "Spinach",
  "Chicken thighs",
  "Parmesan"
];

const readHistory = (): HistoryEntry[] => {
  try {
    const raw = safeGetItem(SHOPPING_HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is HistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as HistoryEntry).key === "string" &&
        typeof (entry as HistoryEntry).text === "string" &&
        typeof (entry as HistoryEntry).count === "number" &&
        typeof (entry as HistoryEntry).lastUsedAt === "number"
    );
  } catch {
    return [];
  }
};

const capitalize = (text: string): string =>
  text.length > 0 ? `${text[0]?.toLocaleUpperCase() ?? ""}${text.slice(1)}` : text;

/** Remembers item names people add or buy, for "buy again" suggestions. */
export const recordShoppingHistory = (names: readonly string[], now = Date.now()): void => {
  if (names.length === 0) {
    return;
  }

  const history = readHistory();
  const byKey = new Map(history.map((entry) => [entry.key, entry]));

  for (const name of names) {
    const text = name.replace(/\s+/gu, " ").trim();

    if (!text || text.length > 60) {
      continue;
    }

    const key = canonicalIngredientKey(text);
    const existing = byKey.get(key);

    byKey.set(key, {
      count: (existing?.count ?? 0) + 1,
      key,
      lastUsedAt: now,
      text: capitalize(existing?.text ?? text)
    });
  }

  const next = Array.from(byKey.values())
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_HISTORY);
  safeSetItem(SHOPPING_HISTORY_KEY, JSON.stringify(next));
};

const scoreEntry = (entry: HistoryEntry, now: number): number => {
  const ageDays = Math.max(0, (now - entry.lastUsedAt) / 86_400_000);
  return entry.count / (1 + ageDays / 14);
};

/**
 * Quick-add suggestions: past items (most used and recent first) then everyday staples, matching
 * `query` when given, skipping anything already on the open list.
 */
export const getShoppingSuggestions = (
  query: string,
  options: {
    exclude?: ReadonlySet<string> | undefined;
    limit?: number | undefined;
    now?: number;
  } = {}
): string[] => {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 8;
  const needle = query.trim().toLocaleLowerCase();
  const exclude = options.exclude ?? new Set<string>();
  const seen = new Set<string>();
  const results: string[] = [];
  const history = readHistory().sort((a, b) => scoreEntry(b, now) - scoreEntry(a, now));
  const candidates = [
    ...history.map((entry) => ({ key: entry.key, text: entry.text })),
    ...DEFAULT_SUGGESTIONS.map((text) => ({ key: canonicalIngredientKey(text), text }))
  ];

  for (const candidate of candidates) {
    if (results.length >= limit) {
      break;
    }

    if (seen.has(candidate.key) || exclude.has(candidate.key)) {
      continue;
    }

    const haystack = candidate.text.toLocaleLowerCase();

    if (needle && (!haystack.includes(needle) || haystack === needle)) {
      continue;
    }

    seen.add(candidate.key);
    results.push(candidate.text);
  }

  return results;
};

/** True once the cook has checked things off before ("Buy again" is only honest then). */
export const hasShoppingHistory = (): boolean => readHistory().length > 0;

/** Canonical keys of the items still to buy (for suggestion filtering). */
export const openItemKeys = (items: readonly WebShoppingItem[]): Set<string> =>
  new Set(items.filter((item) => !item.checked).map((item) => canonicalIngredientKey(item.text)));

/* ------------------------------------------------------------------------------------------ */
/* Per-device list settings                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const SHOPPING_HIDE_STAPLES_KEY = "linkdish:web:shopping-hide-staples:v1";
export const SHOPPING_VIEW_KEY = "linkdish:web:shopping-view:v1";

export type ShoppingView = "aisle" | "recipe";

export const readHideStaples = (): boolean => safeGetItem(SHOPPING_HIDE_STAPLES_KEY) === "true";

export const writeHideStaples = (hide: boolean): void => {
  safeSetItem(SHOPPING_HIDE_STAPLES_KEY, hide ? "true" : "false");
};

export const readShoppingView = (): ShoppingView =>
  safeGetItem(SHOPPING_VIEW_KEY) === "recipe" ? "recipe" : "aisle";

export const writeShoppingView = (view: ShoppingView): void => {
  safeSetItem(SHOPPING_VIEW_KEY, view);
};

/** "just now", "5 min ago", "at 3:04 PM". */
export const formatSyncedAgo = (timestamp: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  return `at ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(timestamp)
  )}`;
};
