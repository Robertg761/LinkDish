import {
  canonicalIngredientKey,
  formatShoppingItemText,
  getIngredientUnitSummary,
  getUnitDefinition,
  mergeShoppingItemLists,
  MAX_SHOPPING_ITEM_TEXT_LENGTH,
  parseIngredientQuantity,
  parseShoppingLine as parseDomainShoppingLine,
  recipeIngredientsToShoppingInputs as domainRecipeIngredientsToShoppingInputs
} from "@linkdish/recipe-domain";
import { useEffect, useSyncExternalStore } from "react";

import { apiClient } from "../../api/client";
import { getLinkDishWebDb, SHOPPING_ITEMS_STORE_NAME } from "../../storage/linkdish-db";

import type {
  DeleteShoppingItemsResponse,
  UpsertShoppingItemsResponse
} from "@linkdish/api-contracts";
import type {
  IngredientUnitsPreference,
  ParsedShoppingLine,
  Recipe,
  ShoppingItem,
  ShoppingQuantity
} from "@linkdish/recipe-domain";

/**
 * The shopping list: IndexedDB records, the domain's unit-aware aggregation, a reactive in-memory
 * cache for the UI, and the household (last-write-wins) sync primitives. Scheduling the sync lives
 * in shopping-sync.ts.
 */

export type ShoppingSyncStatus = "local_only" | "dirty" | "synced" | "sync_failed";

export interface WebShoppingItem extends ShoppingItem {
  createdAt: string;
  deletedAt?: string | undefined;
  isDeleted?: boolean | undefined;
  /**
   * Local-only attribution: every recipe that contributed to this item, in first-seen order.
   * The household contract only carries the first (`recipeId` / `recipeTitle`).
   */
  recipeIds?: string[] | undefined;
  recipeTitles?: string[] | undefined;
  sync: {
    lastError?: string | undefined;
    lastSyncedAt?: string | undefined;
    status: ShoppingSyncStatus;
  };
}

export interface AddShoppingItemInput {
  recipeId?: string | undefined;
  recipeTitle?: string | undefined;
  section?: string | undefined;
  text: string;
}

/** An item whose amount is already known (e.g. from `mergeShoppingInputs`). */
export interface ParsedShoppingItemInput {
  text: string;
  qty?: ShoppingQuantity | null | undefined;
  unit?: string | null | undefined;
  recipeIds?: readonly string[] | undefined;
  recipeTitles?: readonly string[] | undefined;
  section?: string | undefined;
}

export interface ShoppingWriteOptions {
  canSync: boolean;
  userId?: string | undefined;
}

/** How a recipe is scaled when its ingredients go on the list. Structural on purpose. */
export interface ShoppingScaling {
  factor?: number | undefined;
  units?: IngredientUnitsPreference | undefined;
  /** Legacy cook-mode toggle: "alternate" swaps to the recipe's other unit system. */
  unitPreference?: string | undefined;
}

const STORE_NAME = SHOPPING_ITEMS_STORE_NAME;
const LOCAL_SHOPPING_USER = "local";
const CONFLICT_MESSAGE = "Household has a newer copy. Refresh to pull it in.";
/** Contract limits for household sync (packages/recipe-domain shoppingItemSchema). */
export const SHOPPING_SYNC_LIMITS = {
  batch: 300,
  id: 120,
  recipeId: 180,
  recipeTitle: 200,
  section: 120,
  text: MAX_SHOPPING_ITEM_TEXT_LENGTH,
  unit: 40
} as const;
/** Tombstones that can no longer sync are dropped after this long. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const HIGH_SURROGATE_END_PATTERN = /[\uD800-\uDBFF]$/u;
const WHITESPACE_PATTERN = /\s+/gu;
/** List markers people paste along with items: "- ", "• ", "* ", "[ ] ", "[x] ", "1. ", "2) ". */
const LIST_MARKER_PATTERN = /^\s*(?:[-*•·▪◦‣⁃–—]|\[[\sxX✓]?\]|☐|☑|✓|✔|\d{1,3}[.)])\s+/u;

const nowIso = () => new Date().toISOString();

/** Trims and shortens text to `maxLength` without splitting a surrogate pair. */
export const clipText = (text: string, maxLength: number): string => {
  const trimmed = text.replace(WHITESPACE_PATTERN, " ").trim();
  return trimmed.length <= maxLength
    ? trimmed
    : trimmed.slice(0, maxLength).replace(HIGH_SURROGATE_END_PATTERN, "").trimEnd();
};

const timeOf = (value: string | undefined): number => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
};

/** List order: the order things were added (stable while checking items off). */
export const compareShoppingItems = (a: WebShoppingItem, b: WebShoppingItem): number =>
  timeOf(a.createdAt) - timeOf(b.createdAt) || a.id.localeCompare(b.id);

const sortItems = (items: WebShoppingItem[]): WebShoppingItem[] => items.sort(compareShoppingItems);

/** Every recipe title attributed to an item (local list first, then the contract field). */
export const getItemRecipeTitles = (item: WebShoppingItem): string[] =>
  item.recipeTitles?.length ? item.recipeTitles : item.recipeTitle ? [item.recipeTitle] : [];

export const getItemRecipeIds = (item: WebShoppingItem): string[] =>
  item.recipeIds?.length ? item.recipeIds : item.recipeId ? [item.recipeId] : [];

const unionStrings = (left: readonly string[], right: readonly string[]): string[] | undefined => {
  const result = [...left];

  for (const value of right) {
    if (value && !result.includes(value)) {
      result.push(value);
    }
  }

  return result.length > 0 ? result : undefined;
};

const isValidQuantity = (qty: unknown): qty is ShoppingQuantity => {
  if (typeof qty === "number") {
    return Number.isFinite(qty) && qty > 0;
  }

  if (typeof qty !== "object" || qty === null) {
    return false;
  }

  const range = qty as { min?: unknown; max?: unknown };
  return (
    typeof range.min === "number" &&
    typeof range.max === "number" &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min > 0 &&
    range.min <= range.max
  );
};

/* ------------------------------------------------------------------------------------------ */
/* Parsing and formatting                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Pretty text for an item: "⅔ cup brown sugar", "1–2 Tbsp olive oil", "3 large eggs". */
export const shoppingTextFromQuantity = (
  qty: ShoppingQuantity | null | undefined,
  unit: string | null | undefined,
  text: string
): string => formatShoppingItemText({ qty, text, unit });

/** Parses an ingredient line into ShoppingItem fields (the domain parser; contract-safe). */
export const parseShoppingLine = (line: string): ParsedShoppingLine =>
  parseDomainShoppingLine(line);

/**
 * Parses something a person typed or pasted: list markers are dropped, an amount is read when
 * there is one ("2 cups flour"), and lines without an amount keep the words exactly as typed
 * ("milk, oat if possible"). Returns null for blank lines.
 */
export const parseManualShoppingLine = (line: string): ParsedShoppingLine | null => {
  const cleaned = line.replace(LIST_MARKER_PATTERN, "").replace(WHITESPACE_PATTERN, " ").trim();

  if (!cleaned) {
    return null;
  }

  const parsed = parseDomainShoppingLine(cleaned);
  const hasAmount = parsed.qty != null || parsed.unit != null;

  if (!hasAmount || parsed.text.trim().length === 0 || parsed.text === cleaned) {
    return { text: clipText(cleaned, SHOPPING_SYNC_LIMITS.text) };
  }

  return parsed;
};

/**
 * Parses an edited line ("2 cups oat milk, unsweetened") keeping the note after a comma, since a
 * person wrote it on purpose.
 */
export const parseEditedShoppingLine = (line: string): ParsedShoppingLine | null => {
  const cleaned = line.replace(WHITESPACE_PATTERN, " ").trim();

  if (!cleaned) {
    return null;
  }

  const parsed = parseIngredientQuantity(cleaned);
  const item = parsed.item.trim();

  if (!parsed.confident || !item) {
    return { text: clipText(cleaned, SHOPPING_SYNC_LIMITS.text) };
  }

  const domain = parseDomainShoppingLine(cleaned);
  return {
    text: clipText(item, SHOPPING_SYNC_LIMITS.text),
    ...(domain.qty == null ? {} : { qty: domain.qty }),
    ...(domain.unit == null ? {} : { unit: domain.unit })
  };
};

/** Splits pasted text into item lines (blank lines dropped, at most 100). */
export const splitShoppingLines = (text: string): string[] =>
  text
    .split(/\r?\n|\u2028/u)
    .map((line) => line.trim())
    .filter((line) => line.replace(LIST_MARKER_PATTERN, "").trim().length > 0)
    .slice(0, 100);

const resolveUnits = (
  recipe: Pick<Recipe, "ingredients">,
  scaling: ShoppingScaling | undefined
): IngredientUnitsPreference => {
  if (scaling?.units) {
    return scaling.units;
  }

  if (scaling?.unitPreference === "alternate") {
    const summary = getIngredientUnitSummary(recipe.ingredients);
    return summary.primarySystem === "metric" ? "us" : "metric";
  }

  return "original";
};

/**
 * Shopping inputs for a recipe at the given scale and units (domain aggregation underneath),
 * attributed to the recipe. `selected` limits it to some ingredient indexes.
 */
export const recipeIngredientsToShoppingInputs = (
  recipe: Pick<Recipe, "ingredients" | "title">,
  recipeId: string,
  scaling?: ShoppingScaling,
  options: { selected?: ReadonlySet<number> | readonly number[] | undefined } = {}
): AddShoppingItemInput[] =>
  domainRecipeIngredientsToShoppingInputs(recipe, {
    recipeId,
    scale: scaling?.factor && scaling.factor > 0 ? scaling.factor : 1,
    selected: options.selected,
    units: resolveUnits(recipe, scaling)
  });

const roundUpCount = (value: number): number => Math.max(1, Math.ceil(value - 1e-9));

/**
 * People buy whole things: a recipe's "⅝ small onion" or "2 ½ large eggs" goes on the list as
 * 1 onion / 3 eggs. Only counts (no unit, or a count unit such as can, clove or head) round up;
 * cups and grams stay exact.
 */
export const roundUpCountForShopping = <
  T extends { qty?: ShoppingQuantity | null | undefined; unit?: string | null | undefined }
>(
  line: T
): T => {
  if (line.qty == null || (line.unit && getUnitDefinition(line.unit)?.kind !== "count")) {
    return line;
  }

  if (typeof line.qty === "number") {
    return Number.isInteger(line.qty) ? line : { ...line, qty: roundUpCount(line.qty) };
  }

  const min = roundUpCount(line.qty.min);
  const max = roundUpCount(line.qty.max);
  return { ...line, qty: min === max ? min : { max, min } };
};

export const hasShoppingQuantityRange = (item: WebShoppingItem): boolean =>
  item.qty != null && typeof item.qty !== "number";

/* ------------------------------------------------------------------------------------------ */
/* Reactive cache                                                                              */
/* ------------------------------------------------------------------------------------------ */

export type ShoppingListStatus = "idle" | "loading" | "ready" | "error";

export interface ShoppingListSnapshot {
  /** Live (not deleted) items in list order. */
  items: WebShoppingItem[];
  status: ShoppingListStatus;
  error: unknown;
}

const SHOPPING_CHANNEL_NAME = "linkdish-shopping";
const initialSnapshot: ShoppingListSnapshot = { error: null, items: [], status: "idle" };
let snapshot: ShoppingListSnapshot = initialSnapshot;
let loadGeneration = 0;
let inflightLoad: Promise<void> | null = null;
const listeners = new Set<() => void>();

interface ShoppingChannel {
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

type ShoppingChannelFactory = () => ShoppingChannel | null;

const defaultChannelFactory: ShoppingChannelFactory = () => {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }

  try {
    const created = new BroadcastChannel(SHOPPING_CHANNEL_NAME);
    (created as unknown as { unref?: () => void }).unref?.();
    return created as unknown as ShoppingChannel;
  } catch {
    return null;
  }
};

let channelFactory: ShoppingChannelFactory = defaultChannelFactory;
let channel: ShoppingChannel | null | undefined;
let remoteReloadTimer: ReturnType<typeof setTimeout> | null = null;

const emit = (next: Partial<ShoppingListSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => {
    listener();
  });
};

const getChannel = (): ShoppingChannel | null => {
  if (channel !== undefined) {
    return channel;
  }

  channel = channelFactory();

  if (channel) {
    channel.onmessage = () => {
      if (snapshot.status === "idle" || remoteReloadTimer) {
        return;
      }

      remoteReloadTimer = setTimeout(() => {
        remoteReloadTimer = null;
        void loadShoppingList({ force: true });
      }, 60);
    };
  }

  return channel;
};

const notifyOtherTabs = () => {
  try {
    getChannel()?.postMessage({ topic: "shoppingItems", v: 1 });
  } catch {
    // Cross-tab freshness is best effort.
  }
};

/** Applies written records to the cache (and tells other tabs). */
const commitToCache = (
  upserted: readonly WebShoppingItem[],
  deletedIds: readonly string[] = []
) => {
  notifyOtherTabs();

  if (snapshot.status !== "ready") {
    return;
  }

  const byId = new Map(snapshot.items.map((item) => [item.id, item]));

  for (const id of deletedIds) {
    byId.delete(id);
  }

  for (const record of upserted) {
    if (record.isDeleted) {
      byId.delete(record.id);
    } else {
      byId.set(record.id, record);
    }
  }

  emit({ items: sortItems(Array.from(byId.values())) });
};

export const getShoppingListSnapshot = (): ShoppingListSnapshot => snapshot;

export const subscribeShoppingList = (listener: () => void): (() => void) => {
  listeners.add(listener);
  getChannel();

  return () => {
    listeners.delete(listener);
  };
};

/** Reads the list from IndexedDB once (or again with `force`). Never rejects. */
export function loadShoppingList(options: { force?: boolean } = {}): Promise<void> {
  getChannel();

  if (!options.force && snapshot.status === "ready") {
    return Promise.resolve();
  }

  if (inflightLoad && !options.force) {
    return inflightLoad;
  }

  const generation = ++loadGeneration;

  if (snapshot.status !== "ready") {
    emit({ error: null, status: "loading" });
  }

  const run = getShoppingItems().then(
    (items) => {
      if (generation === loadGeneration) {
        emit({ error: null, items, status: "ready" });
      }
    },
    (error: unknown) => {
      if (generation === loadGeneration) {
        emit(snapshot.status === "ready" ? { error } : { error, status: "error" });
      }
    }
  );
  const tracked = run.finally(() => {
    if (inflightLoad === tracked) {
      inflightLoad = null;
    }
  });

  inflightLoad = tracked;
  return tracked;
}

/** The live shopping list, straight from IndexedDB (no network). */
export function useShoppingList(): ShoppingListSnapshot {
  const current = useSyncExternalStore(
    subscribeShoppingList,
    getShoppingListSnapshot,
    getShoppingListSnapshot
  );

  useEffect(() => {
    void loadShoppingList();
  }, []);

  return current;
}

/** Test seams. */
export function setShoppingChannelFactoryForTests(factory: ShoppingChannelFactory | null): void {
  try {
    channel?.close();
  } catch {
    // ignore
  }

  channel = undefined;
  channelFactory = factory ?? defaultChannelFactory;
}

export function resetShoppingListStoreForTests(): void {
  loadGeneration += 1;
  inflightLoad = null;

  if (remoteReloadTimer) {
    clearTimeout(remoteReloadTimer);
    remoteReloadTimer = null;
  }

  setShoppingChannelFactoryForTests(() => null);
  snapshot = initialSnapshot;
  listeners.forEach((listener) => {
    listener();
  });
}

/* ------------------------------------------------------------------------------------------ */
/* IndexedDB                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export async function getShoppingItems(
  options: { includeDeleted?: boolean } = {}
): Promise<WebShoppingItem[]> {
  const db = await getLinkDishWebDb();
  const items = (await db.getAll(STORE_NAME)) as WebShoppingItem[];

  return sortItems(items.filter((item) => options.includeDeleted || !item.isDeleted));
}

/** Writes records and removes ids in one transaction. */
async function writeShoppingRecords(
  records: readonly WebShoppingItem[],
  deletedIds: readonly string[] = []
): Promise<void> {
  if (records.length === 0 && deletedIds.length === 0) {
    return;
  }

  const db = await getLinkDishWebDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  await Promise.all([
    ...records.map((record) => store.put(record)),
    ...deletedIds.map((id) => store.delete(id)),
    tx.done
  ]);
}

/** Writes the given records (only those) in one transaction and updates the cache. */
export async function putShoppingItems(items: WebShoppingItem[]): Promise<void> {
  await writeShoppingRecords(items);
  commitToCache(items);
}

const syncStateFor = (
  options: ShoppingWriteOptions,
  existing?: WebShoppingItem
): WebShoppingItem["sync"] =>
  options.canSync || (existing && existing.sync.status !== "local_only")
    ? { status: "dirty" }
    : { status: "local_only" };

const buildIncomingItem = (
  input: ParsedShoppingItemInput,
  options: ShoppingWriteOptions,
  timestamp: string
): WebShoppingItem | null => {
  const text = clipText(input.text, SHOPPING_SYNC_LIMITS.text);

  if (!text) {
    return null;
  }

  const recipeIds = unionStrings([], input.recipeIds ?? []);
  const recipeTitles = unionStrings([], input.recipeTitles ?? []);
  const unit = input.unit ? clipText(input.unit, SHOPPING_SYNC_LIMITS.unit) : "";
  const section = input.section ? clipText(input.section, SHOPPING_SYNC_LIMITS.section) : "";

  return {
    addedBy: options.userId ?? LOCAL_SHOPPING_USER,
    checked: false,
    checkedBy: null,
    createdAt: timestamp,
    id: crypto.randomUUID(),
    sync: syncStateFor(options),
    text,
    updatedAt: timestamp,
    ...(isValidQuantity(input.qty) ? { qty: input.qty } : {}),
    ...(unit ? { unit } : {}),
    ...(recipeIds ? { recipeId: recipeIds[0], recipeIds } : {}),
    ...(recipeTitles ? { recipeTitle: recipeTitles[0], recipeTitles } : {}),
    ...(section ? { section } : {})
  };
};

const withAttribution = (
  existing: WebShoppingItem,
  incoming: WebShoppingItem
): Pick<WebShoppingItem, "recipeId" | "recipeIds" | "recipeTitle" | "recipeTitles"> => {
  const recipeIds = unionStrings(getItemRecipeIds(existing), getItemRecipeIds(incoming));
  const recipeTitles = unionStrings(getItemRecipeTitles(existing), getItemRecipeTitles(incoming));

  return {
    ...(recipeIds ? { recipeId: existing.recipeId ?? recipeIds[0], recipeIds } : {}),
    ...(recipeTitles ? { recipeTitle: existing.recipeTitle ?? recipeTitles[0], recipeTitles } : {})
  };
};

const applyAmount = (
  base: WebShoppingItem,
  amount: {
    text: string;
    qty?: ShoppingQuantity | null | undefined;
    unit?: string | null | undefined;
  }
): WebShoppingItem => {
  const next: WebShoppingItem = { ...base, text: clipText(amount.text, SHOPPING_SYNC_LIMITS.text) };

  if (isValidQuantity(amount.qty)) {
    next.qty = amount.qty;
  } else {
    delete next.qty;
  }

  if (amount.unit) {
    next.unit = amount.unit;
  } else {
    delete next.unit;
  }

  return next;
};

/**
 * Merges incoming items into a list the way a person expects: same thing with compatible units
 * adds up on the open item ("2 tsp" + "1 Tbsp" sugar → "1 ⅔ Tbsp"); if the only match is already
 * in the cart, it comes back out with just the new amount; otherwise the item is appended.
 * Every contributing recipe is kept. Returns the full list plus the ids that changed.
 */
export const mergeIncomingShoppingItems = (
  existingItems: readonly WebShoppingItem[],
  incomingItems: readonly WebShoppingItem[],
  options: ShoppingWriteOptions = { canSync: false }
): { items: WebShoppingItem[]; changedIds: Set<string> } => {
  const items = [...existingItems];
  const changedIds = new Set<string>();

  for (const incoming of incomingItems) {
    const open = items.filter((item) => !item.isDeleted && !item.checked);
    const captured: { record?: WebShoppingItem } = {};

    mergeShoppingItemLists(open, [incoming], (existing, next, amount) => {
      captured.record = {
        ...applyAmount(existing, amount),
        ...withAttribution(existing, next),
        ...(existing.section ? {} : next.section ? { section: next.section } : {}),
        sync: syncStateFor(options, existing),
        updatedAt:
          timeOf(next.updatedAt) > timeOf(existing.updatedAt) ? next.updatedAt : existing.updatedAt
      };
      return captured.record;
    });

    let record = captured.record;

    if (!record) {
      const key = canonicalIngredientKey(incoming.text);
      const bought = items.find(
        (item) => !item.isDeleted && item.checked && canonicalIngredientKey(item.text) === key
      );

      if (bought) {
        record = {
          ...applyAmount(bought, incoming),
          ...withAttribution(bought, incoming),
          checked: false,
          checkedBy: null,
          sync: syncStateFor(options, bought),
          updatedAt: incoming.updatedAt
        };
      }
    }

    if (!record) {
      items.push(incoming);
      changedIds.add(incoming.id);
      continue;
    }

    const index = items.findIndex((item) => item.id === record.id);
    items[index] = record;
    changedIds.add(record.id);
  }

  return { changedIds, items };
};

/** Old name kept for callers: merges and returns the whole list. */
export const mergeShoppingItems = (
  existingItems: WebShoppingItem[],
  incomingItems: WebShoppingItem[]
): WebShoppingItem[] => mergeIncomingShoppingItems(existingItems, incomingItems).items;

export interface AddShoppingItemsResult {
  /** Records created or updated by this add. */
  changed: WebShoppingItem[];
  /** How many incoming lines were merged into items already on the list. */
  mergedCount: number;
}

/** Adds items whose amounts are already parsed; writes only the changed records. */
export async function addParsedShoppingItems(
  inputs: readonly ParsedShoppingItemInput[],
  options: ShoppingWriteOptions
): Promise<AddShoppingItemsResult> {
  const timestamp = nowIso();
  const incoming = inputs
    .map((input) => buildIncomingItem(input, options, timestamp))
    .filter((item): item is WebShoppingItem => item !== null);

  if (incoming.length === 0) {
    return { changed: [], mergedCount: 0 };
  }

  const existing = await getShoppingItems();
  const { changedIds, items } = mergeIncomingShoppingItems(existing, incoming, options);
  const changed = items.filter((item) => changedIds.has(item.id));
  const createdCount = incoming.filter((item) => changedIds.has(item.id)).length;

  await writeShoppingRecords(changed);
  commitToCache(changed);

  return { changed, mergedCount: incoming.length - createdCount };
}

const toParsedInput = (input: AddShoppingItemInput): ParsedShoppingItemInput | null => {
  const isFromRecipe = Boolean(input.recipeId || input.recipeTitle);
  const parsed = isFromRecipe
    ? roundUpCountForShopping(parseDomainShoppingLine(input.text))
    : parseManualShoppingLine(input.text);

  if (!parsed || !parsed.text.trim()) {
    return null;
  }

  return {
    ...parsed,
    ...(input.recipeId ? { recipeIds: [input.recipeId] } : {}),
    ...(input.recipeTitle ? { recipeTitles: [input.recipeTitle] } : {}),
    ...(input.section ? { section: input.section } : {})
  };
};

/**
 * Adds ingredient or typed lines: recipe lines go through the domain parser, typed lines keep
 * their words when they have no amount. Returns the whole live list.
 */
export async function addShoppingItems(
  inputs: AddShoppingItemInput[],
  options: ShoppingWriteOptions
): Promise<WebShoppingItem[]> {
  const parsed = inputs
    .map(toParsedInput)
    .filter((input): input is ParsedShoppingItemInput => input !== null);

  await addParsedShoppingItems(parsed, options);
  return getShoppingItems();
}

export async function setShoppingItemChecked(
  id: string,
  checked: boolean,
  options: ShoppingWriteOptions
): Promise<WebShoppingItem | undefined> {
  const db = await getLinkDishWebDb();
  const existing = (await db.get(STORE_NAME, id)) as WebShoppingItem | undefined;

  if (!existing || existing.isDeleted) {
    return undefined;
  }

  const updated: WebShoppingItem = {
    ...existing,
    checked,
    checkedBy: checked ? (options.userId ?? LOCAL_SHOPPING_USER) : null,
    sync: syncStateFor(options, existing),
    updatedAt: nowIso()
  };

  await db.put(STORE_NAME, updated);
  commitToCache([updated]);
  return updated;
}

export interface ShoppingItemPatch {
  text?: string | undefined;
  qty?: ShoppingQuantity | null | undefined;
  unit?: string | null | undefined;
}

/** Edits an item's words and/or amount. `null` clears qty/unit. */
export async function updateShoppingItem(
  id: string,
  patch: ShoppingItemPatch,
  options: ShoppingWriteOptions
): Promise<WebShoppingItem | undefined> {
  const db = await getLinkDishWebDb();
  const existing = (await db.get(STORE_NAME, id)) as WebShoppingItem | undefined;

  if (!existing || existing.isDeleted) {
    return undefined;
  }

  const text =
    patch.text === undefined ? existing.text : clipText(patch.text, SHOPPING_SYNC_LIMITS.text);

  if (!text) {
    return existing;
  }

  const updated = applyAmount(
    { ...existing, sync: syncStateFor(options, existing), updatedAt: nowIso() },
    {
      qty: patch.qty === undefined ? existing.qty : patch.qty,
      text,
      unit:
        patch.unit === undefined
          ? (existing.unit ?? null)
          : patch.unit
            ? clipText(patch.unit, SHOPPING_SYNC_LIMITS.unit)
            : null
    }
  );

  await db.put(STORE_NAME, updated);
  commitToCache([updated]);
  return updated;
}

/** Replaces an item's words and amount from an edited line ("3 cups oat milk"). */
export async function updateShoppingItemFromLine(
  id: string,
  line: string,
  options: ShoppingWriteOptions
): Promise<WebShoppingItem | undefined> {
  const parsed = parseEditedShoppingLine(line);

  if (!parsed) {
    return undefined;
  }

  return updateShoppingItem(
    id,
    { qty: parsed.qty ?? null, text: parsed.text, unit: parsed.unit ?? null },
    options
  );
}

/**
 * Removes items: local-only ones are deleted, household ones become tombstones for the next
 * sync. Returns the records as they were, for Undo.
 */
export async function deleteShoppingItems(
  ids: readonly string[],
  options: { canSync: boolean }
): Promise<WebShoppingItem[]> {
  const db = await getLinkDishWebDb();
  const existingItems = (
    await Promise.all(
      ids.map((id) => db.get(STORE_NAME, id) as Promise<WebShoppingItem | undefined>)
    )
  ).filter((item): item is WebShoppingItem => Boolean(item) && !item?.isDeleted);
  const timestamp = nowIso();
  const deletedIds: string[] = [];
  const tombstones: WebShoppingItem[] = [];

  for (const item of existingItems) {
    if (!options.canSync || item.sync.status === "local_only") {
      deletedIds.push(item.id);
    } else {
      tombstones.push({
        ...item,
        deletedAt: timestamp,
        isDeleted: true,
        sync: { status: "dirty" },
        updatedAt: timestamp
      });
    }
  }

  await writeShoppingRecords(tombstones, deletedIds);
  commitToCache(tombstones, deletedIds);
  return existingItems;
}

export async function deleteShoppingItem(id: string, options: { canSync: boolean }): Promise<void> {
  await deleteShoppingItems([id], options);
}

/** Undo for deletes: puts the records back as they were (newer, so household sync keeps them). */
export async function restoreShoppingItems(
  items: readonly WebShoppingItem[]
): Promise<WebShoppingItem[]> {
  const timestamp = nowIso();
  const restored = items.map((item) => {
    const record: WebShoppingItem = {
      ...item,
      sync: item.sync.status === "local_only" ? { status: "local_only" } : { status: "dirty" },
      updatedAt: timestamp
    };
    delete record.isDeleted;
    delete record.deletedAt;
    return record;
  });

  await writeShoppingRecords(restored);
  commitToCache(restored);
  return restored;
}

/** Removes everything in the cart. Returns the removed records for Undo. */
export async function clearCheckedShoppingItems(options: {
  canSync: boolean;
}): Promise<WebShoppingItem[]> {
  const items = await getShoppingItems();
  return deleteShoppingItems(
    items.filter((item) => item.checked).map((item) => item.id),
    options
  );
}

/** Removes every item. Returns the removed records for Undo. */
export async function clearAllShoppingItems(options: {
  canSync: boolean;
}): Promise<WebShoppingItem[]> {
  const items = await getShoppingItems();
  return deleteShoppingItems(
    items.map((item) => item.id),
    options
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Household sync primitives                                                                   */
/* ------------------------------------------------------------------------------------------ */

const clipOptional = (value: string | null | undefined, maxLength: number): string | undefined => {
  const clipped = value ? clipText(value, maxLength) : "";
  return clipped || undefined;
};

/**
 * The contract copy of an item, clipped to the household limits so one long item can't fail the
 * whole batch. Returns null when nothing valid is left (e.g. blank text).
 */
export const toApiShoppingItem = (item: WebShoppingItem): ShoppingItem | null => {
  const text = clipText(item.text, SHOPPING_SYNC_LIMITS.text);
  const recipeId = item.recipeId?.trim() ?? "";
  const recipeTitle = clipOptional(item.recipeTitle, SHOPPING_SYNC_LIMITS.recipeTitle);
  const section = clipOptional(item.section, SHOPPING_SYNC_LIMITS.section);
  const unit = clipOptional(item.unit, SHOPPING_SYNC_LIMITS.unit);
  const addedBy = item.addedBy?.trim() || LOCAL_SHOPPING_USER;
  const checkedBy = item.checkedBy?.trim();

  if (!text || !item.id || item.id.length > SHOPPING_SYNC_LIMITS.id) {
    return null;
  }

  return {
    id: item.id,
    text,
    ...(isValidQuantity(item.qty) ? { qty: item.qty } : {}),
    ...(unit ? { unit } : {}),
    ...(recipeId && recipeId.length <= SHOPPING_SYNC_LIMITS.recipeId ? { recipeId } : {}),
    ...(recipeTitle ? { recipeTitle } : {}),
    ...(section ? { section } : {}),
    addedBy,
    checked: Boolean(item.checked),
    ...(checkedBy ? { checkedBy } : {}),
    updatedAt: Number.isFinite(Date.parse(item.updatedAt)) ? item.updatedAt : nowIso()
  };
};

const isRemoteNewer = (remoteUpdatedAt: string, localUpdatedAt: string): boolean =>
  timeOf(remoteUpdatedAt) > timeOf(localUpdatedAt);

const keepLocalAttribution = (
  remote: ShoppingItem,
  local: WebShoppingItem | undefined
): Pick<WebShoppingItem, "recipeIds" | "recipeTitles"> => {
  if (!local || (local.recipeId ?? null) !== (remote.recipeId ?? null)) {
    return {};
  }

  return {
    ...(local.recipeIds?.length ? { recipeIds: local.recipeIds } : {}),
    ...(local.recipeTitles?.length ? { recipeTitles: local.recipeTitles } : {})
  };
};

/**
 * Applies household items (last write wins). With `prune`, `remoteItems` is the whole household
 * list: synced items that are gone remotely were deleted by someone else and go away here too,
 * and so do stale tombstones.
 */
export async function applyRemoteShoppingItems(
  remoteItems: ShoppingItem[],
  options: { prune?: boolean } = {}
): Promise<void> {
  const localItems = await getShoppingItems({ includeDeleted: true });
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const remoteIds = new Set(remoteItems.map((item) => item.id));
  const writes: WebShoppingItem[] = [];
  const deletedIds: string[] = [];

  for (const remoteItem of remoteItems) {
    const localItem = localById.get(remoteItem.id);

    // Last write wins. The household echoes the version we just pushed with the same updatedAt,
    // which confirms it (synced); only a local change made after it keeps the local copy.
    if (
      localItem &&
      ((localItem.isDeleted && !isRemoteNewer(remoteItem.updatedAt, localItem.updatedAt)) ||
        (localItem.sync.status === "dirty" &&
          isRemoteNewer(localItem.updatedAt, remoteItem.updatedAt)))
    ) {
      continue;
    }

    writes.push({
      ...remoteItem,
      ...keepLocalAttribution(remoteItem, localItem),
      createdAt: localItem?.createdAt ?? remoteItem.updatedAt,
      sync: {
        lastSyncedAt: remoteItem.updatedAt,
        status: "synced"
      }
    });
  }

  if (options.prune) {
    for (const localItem of localItems) {
      if (remoteIds.has(localItem.id)) {
        continue;
      }

      if (localItem.sync.status === "synced" || localItem.isDeleted) {
        deletedIds.push(localItem.id);
      }
    }
  }

  await writeShoppingRecords(writes, deletedIds);
  commitToCache(writes, deletedIds);
}

export async function handleUpsertShoppingSyncResult(
  result: UpsertShoppingItemsResponse
): Promise<void> {
  await applyRemoteShoppingItems(result.items);

  if (result.ignored.length === 0) {
    return;
  }

  const db = await getLinkDishWebDb();
  const conflicts: WebShoppingItem[] = [];

  for (const ignored of result.ignored) {
    const localItem = (await db.get(STORE_NAME, ignored.id)) as WebShoppingItem | undefined;

    if (localItem) {
      conflicts.push({
        ...localItem,
        sync: { lastError: CONFLICT_MESSAGE, status: "sync_failed" }
      });
    }
  }

  await writeShoppingRecords(conflicts);
  commitToCache(conflicts);
}

export async function handleDeleteShoppingSyncResult(
  result: DeleteShoppingItemsResponse
): Promise<void> {
  const db = await getLinkDishWebDb();
  const conflicts: WebShoppingItem[] = [];

  for (const ignored of result.ignored) {
    const localItem = (await db.get(STORE_NAME, ignored.id)) as WebShoppingItem | undefined;

    if (localItem) {
      conflicts.push({
        ...localItem,
        sync: { lastError: CONFLICT_MESSAGE, status: "sync_failed" }
      });
    }
  }

  await writeShoppingRecords(conflicts, result.deletedItemIds);
  commitToCache(conflicts, result.deletedItemIds);
}

/**
 * Drops tombstones that will never sync: local-only ones and ones older than 30 days (e.g. left
 * behind after leaving a household).
 */
export async function pruneShoppingTombstones(now = Date.now()): Promise<number> {
  const items = await getShoppingItems({ includeDeleted: true });
  const stale = items
    .filter(
      (item) =>
        item.isDeleted &&
        (item.sync.status === "local_only" ||
          item.sync.status === "synced" ||
          now - timeOf(item.deletedAt ?? item.updatedAt) > TOMBSTONE_TTL_MS)
    )
    .map((item) => item.id);

  await writeShoppingRecords([], stale);
  return stale.length;
}

export async function pullShoppingItemsFromApi(): Promise<WebShoppingItem[]> {
  const response = await apiClient.getShoppingList();
  await applyRemoteShoppingItems(response.items, { prune: true });
  return getShoppingItems();
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const needsPush = (item: WebShoppingItem) =>
  item.sync.status === "dirty" || item.sync.status === "sync_failed";

/**
 * Pushes changed items (clipped to the contract, in batches), then deletes, then pulls the whole
 * household list. Items that can't be sent are marked so they stop blocking the rest.
 */
export async function syncShoppingItems(options: { canSync: boolean }): Promise<WebShoppingItem[]> {
  if (!options.canSync) {
    return getShoppingItems();
  }

  const allItems = await getShoppingItems({ includeDeleted: true });
  const dirtyActiveItems = allItems.filter((item) => !item.isDeleted && needsPush(item));
  const dirtyDeletedItems = allItems.filter((item) => item.isDeleted && needsPush(item));
  const unsendable: WebShoppingItem[] = [];
  const payload: ShoppingItem[] = [];

  for (const item of dirtyActiveItems) {
    const apiItem = toApiShoppingItem(item);

    if (apiItem) {
      payload.push(apiItem);
    } else if (item.sync.status !== "sync_failed") {
      unsendable.push({
        ...item,
        sync: { lastError: "This item can't be shared with your household.", status: "sync_failed" }
      });
    }
  }

  if (unsendable.length > 0) {
    await writeShoppingRecords(unsendable);
    commitToCache(unsendable);
  }

  for (const batch of chunk(payload, SHOPPING_SYNC_LIMITS.batch)) {
    const result = await apiClient.upsertShoppingItems({ items: batch });
    await handleUpsertShoppingSyncResult(result);
  }

  const deletions = dirtyDeletedItems
    .filter((item) => item.id.length <= SHOPPING_SYNC_LIMITS.id)
    .map((item) => ({ id: item.id, updatedAt: item.updatedAt }));

  for (const batch of chunk(deletions, SHOPPING_SYNC_LIMITS.batch)) {
    const result = await apiClient.deleteShoppingItems({ items: batch });
    await handleDeleteShoppingSyncResult(result);
  }

  const items = await pullShoppingItemsFromApi();
  await pruneShoppingTombstones();
  return items;
}
