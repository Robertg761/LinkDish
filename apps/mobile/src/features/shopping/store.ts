import { parseIngredientQuantity, scaleQuantity } from "@linkdish/recipe-domain";

import type { Recipe, ShoppingItem, ShoppingQuantity } from "@linkdish/recipe-domain";

export type ShoppingSyncStatus = "local_only" | "dirty" | "synced" | "sync_failed";
export type ShoppingUnitMode = "metric" | "original";

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

const normalizeItemText = (text: string): string => text.trim().replace(/\s+/gu, " ").toLowerCase();

const normalizeUnit = (unit: string | null | undefined): string => unit?.trim().toLowerCase() ?? "";

const isRangeQuantity = (
  value: Exclude<ShoppingQuantity, number>
): value is { min: number; max: number } => typeof value === "object" && value !== null;

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

const isRemoteNewer = (remoteUpdatedAt: string, localUpdatedAt: string): boolean =>
  new Date(remoteUpdatedAt).getTime() > new Date(localUpdatedAt).getTime();

const createShoppingItemId = (timestamp: string, index: number): string =>
  `shopping_${timestamp.replace(/\D/gu, "")}_${index}_${Math.random().toString(36).slice(2, 10)}`;

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
): Pick<MobileShoppingItem, "qty" | "text" | "unit"> => {
  const trimmed = line.trim();
  const parsed = parseIngredientQuantity(trimmed);

  if (!parsed.confident) {
    return { text: trimmed };
  }

  return {
    ...(parsed.qty == null ? {} : { qty: parsed.qty }),
    text: parsed.item,
    ...(parsed.unit == null ? {} : { unit: parsed.unit })
  };
};

export const getScaledShoppingIngredientText = (
  text: string,
  scaling: RecipeShoppingScaling
): string => {
  const parsed = parseIngredientQuantity(text);

  if (!parsed.confident) {
    return text;
  }

  if (scaling.unitMode === "metric" && parsed.altQty != null && parsed.altUnit) {
    return scaleQuantity(
      {
        ...parsed,
        altQty: null,
        altUnit: null,
        qty: parsed.altQty,
        unit: parsed.altUnit
      },
      scaling.scaleFactor
    );
  }

  if (scaling.scaleFactor === 1 && (scaling.unitMode ?? "original") === "original") {
    return text;
  }

  return scaleQuantity(parsed, scaling.scaleFactor);
};

export const recipeIngredientsToShoppingInputs = (
  recipe: Recipe,
  recipeId: string,
  scaling: RecipeShoppingScaling
): AddShoppingItemInput[] =>
  recipe.ingredients.map((ingredient) => ({
    recipeId,
    recipeTitle: recipe.title,
    ...(ingredient.section ? { section: ingredient.section } : {}),
    text: getScaledShoppingIngredientText(ingredient.text, scaling)
  }));

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
): MobileShoppingItem[] => {
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

export const deleteShoppingItemInList = (
  items: MobileShoppingItem[],
  id: string,
  options: ShoppingMutationOptions
): MobileShoppingItem[] =>
  items.flatMap((item) => {
    if (item.id !== id) {
      return [item];
    }

    if (!options.canSync || item.sync.status === "local_only") {
      return [];
    }

    const timestamp = options.now ?? new Date().toISOString();

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

export const applyRemoteShoppingItems = (
  localItems: MobileShoppingItem[],
  remoteItems: ShoppingItem[]
): MobileShoppingItem[] => {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const nextById = new Map(localItems.map((item) => [item.id, item]));

  for (const remoteItem of remoteItems) {
    const localItem = localById.get(remoteItem.id);

    if (
      localItem &&
      (localItem.sync.status === "dirty" || localItem.isDeleted) &&
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

export const sortShoppingItems = (items: MobileShoppingItem[]): MobileShoppingItem[] =>
  [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

export const parseShoppingItems = (serializedItems: string | null): MobileShoppingItem[] => {
  if (!serializedItems) {
    return [];
  }

  try {
    const parsed = JSON.parse(serializedItems) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
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
  } catch {
    return [];
  }
};

export const serializeShoppingItems = (items: MobileShoppingItem[]): string =>
  JSON.stringify(items);

export const hasShoppingQuantityRange = (item: MobileShoppingItem): boolean =>
  item.qty != null && typeof item.qty !== "number" && isRangeQuantity(item.qty);
