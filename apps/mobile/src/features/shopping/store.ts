import {
  formatShoppingItemText,
  getDisplayIngredientText,
  groupByShoppingCategory,
  mergeShoppingItemLists,
  parseShoppingLine as parseDomainShoppingLine,
  recipeIngredientsToShoppingInputs as buildDomainShoppingInputs
} from "@linkdish/recipe-domain";

import type {
  IngredientUnitsPreference,
  MergeShoppingOptions,
  Recipe,
  ShoppingCategoryId,
  ShoppingItem,
  ShoppingQuantity
} from "@linkdish/recipe-domain";

export type ShoppingSyncStatus = "local_only" | "dirty" | "synced" | "sync_failed";
/** How ingredient amounts are shown when a recipe is added: as written, or in US/metric units. */
export type ShoppingUnitMode = IngredientUnitsPreference;

export interface MobileShoppingItem extends ShoppingItem {
  createdAt: string;
  deletedAt?: string | undefined;
  isDeleted?: boolean | undefined;
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

export interface ShoppingMutationOptions {
  canSync: boolean;
  now?: string | undefined;
  userId?: string | undefined;
}

export interface RecipeShoppingScaling {
  scaleFactor: number;
  unitMode?: ShoppingUnitMode | undefined;
}

const LOCAL_SHOPPING_USER = "local";

/**
 * Items merge when they are the same thing to buy (the domain's canonical ingredient key:
 * "2 large eggs" and "1 egg", "scallions" and "green onions") and their amounts can be added.
 *
 * Unit conversion is on deliberately: a shopping list is about what to buy, so "2 tsp cumin"
 * and "1 Tbsp cumin", or "1 cup milk" and "250 ml milk", belong on one line. The domain never
 * converts between volume and weight (no density guesses) or between counts and measures, so
 * "2 cups flour" and "100 g flour" still stay separate lines.
 */
export const SHOPPING_MERGE_OPTIONS: MergeShoppingOptions = { convertUnits: true };

const isRemoteNewer = (remoteUpdatedAt: string, localUpdatedAt: string): boolean =>
  new Date(remoteUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();

const createShoppingItemId = (timestamp: string, index: number): string =>
  `shopping_${timestamp.replace(/\D/gu, "")}_${index}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Display text for a stored item: friendly fractions and ranges ("⅔ cup milk", "1–2 tsp
 * salt", "3 large eggs") instead of raw floats such as "0.6666666666666666 cup".
 */
export const shoppingTextFromQuantity = (
  qty: ShoppingQuantity | null | undefined,
  unit: string | null | undefined,
  text: string
): string => formatShoppingItemText({ qty, text, unit });

export const getShoppingItemDisplayText = (
  item: Pick<MobileShoppingItem, "qty" | "text" | "unit">
): string => formatShoppingItemText(item);

/**
 * Parses a typed or recipe line into the stored item fields (see the domain's
 * parseShoppingLine): the cleaned item name, a positive quantity (ranges kept) and a
 * canonical unit. "1 (15-ounce) can chickpeas, drained" becomes 1 can "chickpeas (15-ounce)".
 */
export const parseShoppingLine = (
  line: string
): Pick<MobileShoppingItem, "qty" | "text" | "unit"> => {
  const parsed = parseDomainShoppingLine(line);

  return {
    ...(parsed.qty == null ? {} : { qty: parsed.qty }),
    text: parsed.text,
    ...(parsed.unit == null ? {} : { unit: parsed.unit })
  };
};

export const getScaledShoppingIngredientText = (
  text: string,
  scaling: RecipeShoppingScaling
): string =>
  getDisplayIngredientText(text, {
    keepOriginalText: true,
    scale: scaling.scaleFactor,
    units: scaling.unitMode ?? "original"
  });

export const recipeIngredientsToShoppingInputs = (
  recipe: Recipe,
  recipeId: string,
  scaling: RecipeShoppingScaling
): AddShoppingItemInput[] =>
  buildDomainShoppingInputs(recipe, {
    recipeId,
    scale: scaling.scaleFactor,
    units: scaling.unitMode ?? "original"
  });

export const toApiShoppingItem = (item: MobileShoppingItem): ShoppingItem => ({
  id: item.id,
  text: item.text,
  ...(item.qty == null ? {} : { qty: item.qty }),
  ...(item.unit == null ? {} : { unit: item.unit }),
  ...(item.recipeId == null ? {} : { recipeId: item.recipeId }),
  ...(item.recipeTitle == null ? {} : { recipeTitle: item.recipeTitle }),
  ...(item.section == null ? {} : { section: item.section }),
  addedBy: item.addedBy,
  checked: item.checked,
  ...(item.checkedBy == null ? {} : { checkedBy: item.checkedBy }),
  updatedAt: item.updatedAt
});

export const mergeShoppingItems = (
  existingItems: MobileShoppingItem[],
  incomingItems: MobileShoppingItem[]
): MobileShoppingItem[] =>
  mergeShoppingItemLists(
    existingItems,
    incomingItems,
    (existing, incoming, merged): MobileShoppingItem => ({
      ...existing,
      checked: false,
      checkedBy: null,
      qty: merged.qty ?? null,
      recipeId: existing.recipeId ?? incoming.recipeId,
      recipeTitle: existing.recipeTitle ?? incoming.recipeTitle,
      section: existing.section ?? incoming.section,
      sync:
        existing.sync.status === "local_only" && incoming.sync.status === "local_only"
          ? { status: "local_only" }
          : { status: "dirty" },
      text: merged.text,
      unit: merged.unit ?? null,
      updatedAt:
        new Date(incoming.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
          ? incoming.updatedAt
          : existing.updatedAt
    }),
    SHOPPING_MERGE_OPTIONS
  );

export const addShoppingItemsToList = (
  existingItems: MobileShoppingItem[],
  inputs: AddShoppingItemInput[],
  options: ShoppingMutationOptions
): MobileShoppingItem[] => {
  const timestamp = options.now ?? new Date().toISOString();
  const incoming = inputs
    .map((input, index): MobileShoppingItem | null => {
      const parsed = parseShoppingLine(input.text);

      if (!parsed.text.trim()) {
        return null;
      }

      return {
        id: createShoppingItemId(timestamp, index),
        createdAt: timestamp,
        text: parsed.text,
        ...(parsed.qty == null ? {} : { qty: parsed.qty }),
        ...(parsed.unit == null ? {} : { unit: parsed.unit }),
        ...(input.recipeId ? { recipeId: input.recipeId } : {}),
        ...(input.recipeTitle ? { recipeTitle: input.recipeTitle } : {}),
        ...(input.section ? { section: input.section } : {}),
        addedBy: options.userId ?? LOCAL_SHOPPING_USER,
        checked: false,
        checkedBy: null,
        sync: { status: options.canSync ? "dirty" : "local_only" },
        updatedAt: timestamp
      } satisfies MobileShoppingItem;
    })
    .filter((item): item is MobileShoppingItem => item != null);

  return mergeShoppingItems(existingItems, incoming);
};

export const setShoppingItemCheckedInList = (
  items: MobileShoppingItem[],
  id: string,
  checked: boolean,
  options: ShoppingMutationOptions
): MobileShoppingItem[] =>
  items.map((item) =>
    item.id === id
      ? {
          ...item,
          checked,
          checkedBy: checked ? (options.userId ?? LOCAL_SHOPPING_USER) : null,
          sync: { status: options.canSync ? "dirty" : "local_only" },
          updatedAt: options.now ?? new Date().toISOString()
        }
      : item
  );

export const markShoppingItemsSyncFailed = (
  items: MobileShoppingItem[],
  ids: Set<string>,
  message: string
): MobileShoppingItem[] =>
  items.map((item) =>
    ids.has(item.id)
      ? {
          ...item,
          sync: {
            lastError: message,
            status: "sync_failed"
          }
        }
      : item
  );

/**
 * Removes items: local-only items (or any item when the list does not sync) disappear, synced
 * items become dirty tombstones so the household list learns about the delete.
 */
export const deleteShoppingItemsInList = (
  items: MobileShoppingItem[],
  ids: ReadonlySet<string>,
  options: ShoppingMutationOptions
): MobileShoppingItem[] => {
  const timestamp = options.now ?? new Date().toISOString();

  return items.flatMap((item) => {
    if (!ids.has(item.id)) {
      return [item];
    }

    if (!options.canSync || item.sync.status === "local_only") {
      return [];
    }

    return [
      {
        ...item,
        deletedAt: timestamp,
        isDeleted: true,
        sync: { status: "dirty" },
        updatedAt: timestamp
      }
    ];
  });
};

export const deleteShoppingItemInList = (
  items: MobileShoppingItem[],
  id: string,
  options: ShoppingMutationOptions
): MobileShoppingItem[] => deleteShoppingItemsInList(items, new Set([id]), options);

/** "Clear checked": removes every checked, not-yet-deleted item in one mutation. */
export const clearCheckedShoppingItemsInList = (
  items: MobileShoppingItem[],
  options: ShoppingMutationOptions
): MobileShoppingItem[] =>
  deleteShoppingItemsInList(
    items,
    new Set(items.filter((item) => item.checked && !item.isDeleted).map((item) => item.id)),
    options
  );

export interface ShoppingAisleGroup {
  category: ShoppingCategoryId;
  items: MobileShoppingItem[];
  label: string;
}

/** Groups items by grocery aisle in store-walk order (Produce, Meat & Seafood, Dairy & Eggs...). */
export const groupShoppingItemsByAisle = (items: MobileShoppingItem[]): ShoppingAisleGroup[] =>
  groupByShoppingCategory(items, (item) => getShoppingItemDisplayText(item));

export const applyRemoteShoppingItems = (
  localItems: MobileShoppingItem[],
  remoteItems: ShoppingItem[]
): MobileShoppingItem[] => {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const nextById = new Map(localItems.map((item) => [item.id, item]));

  for (const remoteItem of remoteItems) {
    const localItem = localById.get(remoteItem.id);

    // A local edit or tombstone that has not been pushed yet wins unless the remote edit is
    // strictly newer. A same-timestamp remote copy is not proof that this edit reached the
    // server: a merge into an item stamped ahead of this device's clock keeps that timestamp, and
    // a response computed before the merge carries the old copy. The echo of what this pass
    // pushed is already marked synced by markShoppingItemsSynced before this runs.
    if (
      localItem &&
      (localItem.isDeleted ||
        localItem.sync.status === "dirty" ||
        localItem.sync.status === "sync_failed") &&
      !isRemoteNewer(remoteItem.updatedAt, localItem.updatedAt)
    ) {
      continue;
    }

    nextById.set(remoteItem.id, {
      ...remoteItem,
      createdAt: localItem?.createdAt ?? remoteItem.updatedAt,
      sync: {
        lastSyncedAt: remoteItem.updatedAt,
        status: "synced"
      }
    });
  }

  return Array.from(nextById.values());
};

/**
 * Marks items the server accepted as synced. `pushedVersions` maps each pushed id to the
 * updatedAt that was sent; an item edited again while the push was in flight keeps its newer,
 * still-dirty version so the follow-up sync sends it.
 */
export const markShoppingItemsSynced = (
  items: MobileShoppingItem[],
  pushedVersions: ReadonlyMap<string, string>,
  syncedAt: string
): MobileShoppingItem[] =>
  items.map((item) =>
    pushedVersions.get(item.id) === item.updatedAt && !item.isDeleted
      ? { ...item, sync: { lastSyncedAt: syncedAt, status: "synced" } }
      : item
  );

/** Items waiting to be pushed to the household list (edits and delete tombstones). */
export const getSyncableDirtyItems = (items: MobileShoppingItem[]): MobileShoppingItem[] =>
  items.filter((item) => item.sync.status === "dirty" || item.sync.status === "sync_failed");

export const sortShoppingItems = (items: MobileShoppingItem[]): MobileShoppingItem[] =>
  [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

export type ShoppingItemsReadStatus = "corrupt" | "empty" | "ok";

export interface ShoppingItemsReadResult {
  items: MobileShoppingItem[];
  status: ShoppingItemsReadStatus;
}

/**
 * Reads the stored shopping list and reports whether the blob itself was readable.
 *
 * A `corrupt` status must not be treated as an empty list: persisting over it
 * would turn a recoverable read failure into permanent data loss.
 */
export const readShoppingItems = (serializedItems: string | null): ShoppingItemsReadResult => {
  if (!serializedItems) {
    return { items: [], status: "empty" };
  }

  try {
    const parsed = JSON.parse(serializedItems) as unknown;

    if (!Array.isArray(parsed)) {
      return { items: [], status: "corrupt" };
    }

    const items = parsed
      .filter((item): item is MobileShoppingItem => {
        if (typeof item !== "object" || item === null) {
          return false;
        }

        const candidate = item as Partial<MobileShoppingItem>;

        return (
          typeof candidate.id === "string" &&
          typeof candidate.text === "string" &&
          typeof candidate.addedBy === "string" &&
          typeof candidate.checked === "boolean" &&
          typeof candidate.updatedAt === "string" &&
          typeof candidate.createdAt === "string" &&
          typeof candidate.sync === "object" &&
          candidate.sync !== null
        );
      })
      .map((item) => ({
        ...item,
        sync: {
          ...item.sync,
          status:
            item.sync.status === "dirty" ||
            item.sync.status === "local_only" ||
            item.sync.status === "sync_failed" ||
            item.sync.status === "synced"
              ? item.sync.status
              : "local_only"
        }
      }));

    return { items, status: "ok" };
  } catch {
    return { items: [], status: "corrupt" };
  }
};

export const parseShoppingItems = (serializedItems: string | null): MobileShoppingItem[] =>
  readShoppingItems(serializedItems).items;

export const serializeShoppingItems = (items: MobileShoppingItem[]): string =>
  JSON.stringify(items);
