import { parseIngredientQuantity } from "@linkdish/recipe-domain";

import { apiClient } from "../../api/client";
import { getLinkDishWebDb, SHOPPING_ITEMS_STORE_NAME } from "../../storage/linkdish-db";
import { getScaledIngredientText, type RecipeScalingState } from "../recipes/CookMode";

import type {
  DeleteShoppingItemsResponse,
  UpsertShoppingItemsResponse
} from "@linkdish/api-contracts";
import type { Recipe, ShoppingItem, ShoppingQuantity } from "@linkdish/recipe-domain";

export type ShoppingSyncStatus = "local_only" | "dirty" | "synced" | "sync_failed";

export interface WebShoppingItem extends ShoppingItem {
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

const STORE_NAME = SHOPPING_ITEMS_STORE_NAME;
const LOCAL_SHOPPING_USER = "local";

const nowIso = () => new Date().toISOString();

const normalizeItemText = (text: string): string => text.trim().replace(/\s+/gu, " ").toLowerCase();

const normalizeUnit = (unit: string | null | undefined): string => unit?.trim().toLowerCase() ?? "";

const isRangeQuantity = (
  value: Exclude<ShoppingQuantity, number>
): value is { min: number; max: number } => typeof value === "object";

const addQuantities = (
  left: ShoppingQuantity | null | undefined,
  right: ShoppingQuantity | null | undefined
): ShoppingQuantity | null | undefined => {
  if (left == null) {
    return right;
  }

  if (right == null) {
    return left;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left + right;
  }

  if (typeof left !== "number" && typeof right !== "number") {
    return {
      min: left.min + right.min,
      max: left.max + right.max
    };
  }

  return undefined;
};

const toApiShoppingItem = (item: WebShoppingItem): ShoppingItem => ({
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

const isRemoteNewer = (remoteUpdatedAt: string, localUpdatedAt: string): boolean =>
  new Date(remoteUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();

export const shoppingTextFromQuantity = (
  qty: ShoppingQuantity | null | undefined,
  unit: string | null | undefined,
  text: string
): string => {
  if (qty == null) {
    return text;
  }

  const quantityText = typeof qty === "number" ? String(qty) : `${qty.min}-${qty.max}`;
  return `${quantityText}${unit ? ` ${unit}` : ""} ${text}`.trim();
};

export const parseShoppingLine = (
  line: string
): Pick<WebShoppingItem, "qty" | "text" | "unit"> => {
  const parsed = parseIngredientQuantity(line);

  if (!parsed.confident) {
    return { text: line.trim() };
  }

  return {
    ...(parsed.qty == null ? {} : { qty: parsed.qty }),
    text: parsed.item,
    ...(parsed.unit == null ? {} : { unit: parsed.unit })
  };
};

export const recipeIngredientsToShoppingInputs = (
  recipe: Recipe,
  recipeId: string,
  scaling: RecipeScalingState
): AddShoppingItemInput[] =>
  recipe.ingredients.map((ingredient) => ({
    recipeId,
    recipeTitle: recipe.title,
    ...(ingredient.section ? { section: ingredient.section } : {}),
    text: getScaledIngredientText(ingredient.text, scaling)
  }));

export const mergeShoppingItems = (
  existingItems: WebShoppingItem[],
  incomingItems: WebShoppingItem[]
): WebShoppingItem[] => {
  const mergedItems = [...existingItems];

  for (const incoming of incomingItems) {
    const matchingIndex = mergedItems.findIndex(
      (item) =>
        !item.isDeleted &&
        !incoming.isDeleted &&
        normalizeItemText(item.text) === normalizeItemText(incoming.text) &&
        normalizeUnit(item.unit) === normalizeUnit(incoming.unit)
    );

    if (matchingIndex === -1) {
      mergedItems.push(incoming);
      continue;
    }

    const existing = mergedItems[matchingIndex];
    if (!existing) {
      mergedItems.push(incoming);
      continue;
    }

    const nextQty = addQuantities(existing.qty, incoming.qty);
    mergedItems[matchingIndex] = {
      ...existing,
      checked: false,
      checkedBy: null,
      qty: nextQty,
      recipeId: existing.recipeId ?? incoming.recipeId,
      recipeTitle: existing.recipeTitle ?? incoming.recipeTitle,
      section: existing.section ?? incoming.section,
      sync:
        existing.sync.status === "local_only" && incoming.sync.status === "local_only"
          ? { status: "local_only" }
          : { status: "dirty" },
      updatedAt:
        new Date(incoming.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
          ? incoming.updatedAt
          : existing.updatedAt
    };
  }

  return mergedItems;
};

export async function getShoppingItems(options: { includeDeleted?: boolean } = {}): Promise<WebShoppingItem[]> {
  const db = await getLinkDishWebDb();
  const items = (await db.getAll(STORE_NAME)) as WebShoppingItem[];

  return items
    .filter((item) => options.includeDeleted || !item.isDeleted)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function putShoppingItems(items: WebShoppingItem[]): Promise<void> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(STORE_NAME, "readwrite");

  for (const item of items) {
    await tx.objectStore(STORE_NAME).put(item);
  }
}

export async function addShoppingItems(
  inputs: AddShoppingItemInput[],
  options: { canSync: boolean; userId?: string | undefined }
): Promise<WebShoppingItem[]> {
  const timestamp = nowIso();
  const incoming = inputs
    .map((input) => {
      const parsed = parseShoppingLine(input.text);
      const item: WebShoppingItem = {
        id: crypto.randomUUID(),
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
      };

      return item;
    })
    .filter((item) => item.text.trim().length > 0);

  const existing = await getShoppingItems({ includeDeleted: true });
  const merged = mergeShoppingItems(existing, incoming);
  await putShoppingItems(merged);

  return getShoppingItems();
}

export async function setShoppingItemChecked(
  id: string,
  checked: boolean,
  options: { canSync: boolean; userId?: string | undefined }
): Promise<WebShoppingItem | undefined> {
  const db = await getLinkDishWebDb();
  const existing = (await db.get(STORE_NAME, id)) as WebShoppingItem | undefined;

  if (!existing) {
    return undefined;
  }

  const updated: WebShoppingItem = {
    ...existing,
    checked,
    checkedBy: checked ? (options.userId ?? LOCAL_SHOPPING_USER) : null,
    sync: { status: options.canSync ? "dirty" : "local_only" },
    updatedAt: nowIso()
  };

  await db.put(STORE_NAME, updated);
  return updated;
}

export async function deleteShoppingItem(
  id: string,
  options: { canSync: boolean }
): Promise<void> {
  const db = await getLinkDishWebDb();
  const existing = (await db.get(STORE_NAME, id)) as WebShoppingItem | undefined;

  if (!existing) {
    return;
  }

  if (!options.canSync || existing.sync.status === "local_only") {
    await db.delete(STORE_NAME, id);
    return;
  }

  await db.put(STORE_NAME, {
    ...existing,
    deletedAt: nowIso(),
    isDeleted: true,
    sync: { status: "dirty" },
    updatedAt: nowIso()
  } satisfies WebShoppingItem);
}

export async function applyRemoteShoppingItems(remoteItems: ShoppingItem[]): Promise<void> {
  const db = await getLinkDishWebDb();
  const localItems = (await db.getAll(STORE_NAME)) as WebShoppingItem[];
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  for (const remoteItem of remoteItems) {
    const localItem = localById.get(remoteItem.id);

    if (
      localItem &&
      (localItem.sync.status === "dirty" || localItem.isDeleted) &&
      !isRemoteNewer(remoteItem.updatedAt, localItem.updatedAt)
    ) {
      continue;
    }

    await store.put({
      ...remoteItem,
      createdAt: localItem?.createdAt ?? remoteItem.updatedAt,
      sync: {
        lastSyncedAt: remoteItem.updatedAt,
        status: "synced"
      }
    } satisfies WebShoppingItem);
  }
}

export async function handleUpsertShoppingSyncResult(
  result: UpsertShoppingItemsResponse
): Promise<void> {
  await applyRemoteShoppingItems(result.items);

  if (result.ignored.length === 0) {
    return;
  }

  const db = await getLinkDishWebDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  for (const ignored of result.ignored) {
    const localItem = (await store.get(ignored.id)) as WebShoppingItem | undefined;

    if (!localItem) {
      continue;
    }

    await store.put({
      ...localItem,
      sync: {
        lastError: "Household has a newer copy. Refresh to pull it in.",
        status: "sync_failed"
      }
    });
  }
}

export async function handleDeleteShoppingSyncResult(
  result: DeleteShoppingItemsResponse
): Promise<void> {
  const db = await getLinkDishWebDb();

  for (const id of result.deletedItemIds) {
    await db.delete(STORE_NAME, id);
  }

  for (const ignored of result.ignored) {
    const localItem = (await db.get(STORE_NAME, ignored.id)) as WebShoppingItem | undefined;

    if (!localItem) {
      continue;
    }

    await db.put(STORE_NAME, {
      ...localItem,
      sync: {
        lastError: "Household has a newer copy. Refresh to pull it in.",
        status: "sync_failed"
      }
    });
  }
}

export async function pullShoppingItemsFromApi(): Promise<WebShoppingItem[]> {
  const response = await apiClient.getShoppingList();
  await applyRemoteShoppingItems(response.items);
  return getShoppingItems();
}

export async function syncShoppingItems(options: { canSync: boolean }): Promise<WebShoppingItem[]> {
  if (!options.canSync) {
    return getShoppingItems();
  }

  const allItems = await getShoppingItems({ includeDeleted: true });
  const dirtyActiveItems = allItems.filter(
    (item) => !item.isDeleted && (item.sync.status === "dirty" || item.sync.status === "sync_failed")
  );
  const dirtyDeletedItems = allItems.filter(
    (item) => item.isDeleted && (item.sync.status === "dirty" || item.sync.status === "sync_failed")
  );

  if (dirtyActiveItems.length > 0) {
    const result = await apiClient.upsertShoppingItems({
      items: dirtyActiveItems.map(toApiShoppingItem)
    });
    await handleUpsertShoppingSyncResult(result);
  }

  if (dirtyDeletedItems.length > 0) {
    const result = await apiClient.deleteShoppingItems({
      items: dirtyDeletedItems.map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt
      }))
    });
    await handleDeleteShoppingSyncResult(result);
  }

  return pullShoppingItemsFromApi();
}

export const hasShoppingQuantityRange = (item: WebShoppingItem): boolean =>
  item.qty != null && typeof item.qty !== "number" && isRangeQuantity(item.qty);
