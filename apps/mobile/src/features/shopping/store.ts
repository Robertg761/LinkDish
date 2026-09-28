import {
  formatShoppingItemText,
  getDisplayIngredientText,
  groupByShoppingCategory,
  MAX_SHOPPING_ITEM_TEXT_LENGTH,
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
    /**
     * Local only (never sent): the household this item belongs to. Set when it is written in, or
     * confirmed by, a household; its changes are only ever sent back there, and while another
     * household's account is signed in it stays on this device, out of that account's list, until
     * its own household syncs again. Unsent changes stored before it existed get the household
     * the signed-in account's next check confirms (claimShoppingChanges), or, for an item another
     * account added, that account's (or the household whose list has the item). Unsent changes
     * kept for another household are dropped after 30 days (pruneStaleShoppingRecords).
     */
    householdId?: string | undefined;
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
  /**
   * The household the list syncs with right now, when there is one (see `sync.householdId`).
   * Other households' records are not on its list: nothing merges into them and they can't be
   * checked off or deleted.
   */
  householdId?: string | undefined;
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

const HIGH_SURROGATE_END_PATTERN = /[\uD800-\uDBFF]$/u;

/**
 * Keeps an item name within the household list's limit (the domain's shoppingItemSchema).
 * Parsing clips names already, but re-inflecting a clipped name for a merged total can add a
 * character, and older app versions stored names unclipped. One over-long name makes the
 * household list reject the whole sync batch, so every later edit would fail with it.
 */
const clipToLength = (text: string, maxLength: number): string =>
  text.length <= maxLength
    ? text
    : text.slice(0, maxLength).replace(HIGH_SURROGATE_END_PATTERN, "").trimEnd();

const clipShoppingItemText = (text: string): string =>
  clipToLength(text, MAX_SHOPPING_ITEM_TEXT_LENGTH);

/** The household list's limits for an item's other text fields (the domain's shoppingItemSchema). */
const API_FIELD_MAX_LENGTH = {
  recipeId: 180,
  recipeTitle: 200,
  section: 120,
  unit: 40
} as const;

/** An optional field within its limit, or undefined when nothing is left to send. */
const clipApiField = (
  value: string | null | undefined,
  field: keyof typeof API_FIELD_MAX_LENGTH
): string | undefined => {
  const clipped = value == null ? "" : clipToLength(value.trim(), API_FIELD_MAX_LENGTH[field]);
  return clipped.length > 0 ? clipped : undefined;
};

const createShoppingItemId = (timestamp: string, index: number): string =>
  `shopping_${timestamp.replace(/\D/gu, "")}_${index}_${Math.random().toString(36).slice(2, 10)}`;

/** A change the household list hasn't confirmed yet (an edit or a deletion). */
const needsPush = (item: Pick<MobileShoppingItem, "sync">): boolean =>
  item.sync.status === "dirty" || item.sync.status === "sync_failed";

/**
 * Changes that may never sync are dropped after this long: unsent changes kept for another
 * household. They are only sent when that household syncs on this device again, and by then it
 * may well have removed the item, which the change would bring back.
 */
const STALE_CHANGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * True for an unsent change that another account (not `userId`) left on this device without
 * naming a household (stored before changes recorded it): the item was added by that account
 * (`addedBy`, the account id; "local" when added signed out). It may never have been sent, so no
 * household has it and the API would create it in whichever one it is sent to: it is neither
 * claimed for nor sent to `userId`'s household. It waits for its own account's claim
 * (claimShoppingChanges), or for a household whose list has the item (applyRemoteShoppingItems).
 * An edit `userId` makes to it records `userId`'s household (syncStateAfterEdit), so it is theirs
 * from then. (A local change clears `lastSyncedAt`, so an edit of a synced item looks the same
 * until that list shows it.)
 */
const isAnotherAccountsChange = (item: MobileShoppingItem, userId: string): boolean => {
  const addedBy = item.addedBy.trim();

  return (
    needsPush(item) &&
    !item.sync.householdId &&
    !item.sync.lastSyncedAt &&
    addedBy.length > 0 &&
    addedBy !== LOCAL_SHOPPING_USER &&
    addedBy !== userId
  );
};

/**
 * True when the item is kept for a household other than `householdId` (see `sync.householdId`):
 * it came from, or was changed in, another household (another account used this device, or this
 * one moved). Never sent to `householdId`, and left out of its list. Signed out (no household),
 * nothing is another household's.
 */
export const belongsToOtherHousehold = (
  item: Pick<MobileShoppingItem, "sync">,
  householdId: string | null | undefined
): boolean =>
  Boolean(householdId && item.sync.householdId && item.sync.householdId !== householdId);

/** `sync.householdId` of an item, to spread into its next sync state (nothing when it has none). */
const householdOf = (
  item: Pick<MobileShoppingItem, "sync">
): Pick<MobileShoppingItem["sync"], "householdId"> =>
  item.sync.householdId ? { householdId: item.sync.householdId } : {};

/**
 * Sync state after a local edit. An item keeps the household it belongs to, even when edited
 * signed out or by the next account on this device, so its change can only ever go back there;
 * any other item joins the current household when the list syncs.
 */
const syncStateAfterEdit = (
  options: Pick<ShoppingMutationOptions, "canSync" | "householdId">,
  existing?: MobileShoppingItem
): MobileShoppingItem["sync"] => {
  const householdId =
    existing?.sync.householdId ?? (options.canSync ? options.householdId : undefined);

  return {
    ...(householdId ? { householdId } : {}),
    status: options.canSync ? "dirty" : "local_only"
  };
};

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

/**
 * The item as the household list accepts it. Every text field is clipped to its limit: one
 * over-long field (a long recipe title or section, a stored name from an older version) would
 * make the list reject the whole sync batch.
 */
export const toApiShoppingItem = (item: MobileShoppingItem): ShoppingItem => {
  const unit = clipApiField(item.unit, "unit");
  const recipeId = clipApiField(item.recipeId, "recipeId");
  const recipeTitle = clipApiField(item.recipeTitle, "recipeTitle");
  const section = clipApiField(item.section, "section");

  return {
    id: item.id,
    text: clipShoppingItemText(item.text),
    ...(item.qty == null ? {} : { qty: item.qty }),
    ...(unit === undefined ? {} : { unit }),
    ...(recipeId === undefined ? {} : { recipeId }),
    ...(recipeTitle === undefined ? {} : { recipeTitle }),
    ...(section === undefined ? {} : { section }),
    addedBy: item.addedBy,
    checked: item.checked,
    ...(item.checkedBy == null ? {} : { checkedBy: item.checkedBy }),
    updatedAt: item.updatedAt
  };
};

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
      sync: {
        // The merged item keeps the existing id, so it stays with that item's household.
        ...householdOf(existing.sync.householdId ? existing : incoming),
        status:
          existing.sync.status === "local_only" && incoming.sync.status === "local_only"
            ? "local_only"
            : "dirty"
      },
      text: clipShoppingItemText(merged.text),
      unit: merged.unit ?? null,
      updatedAt:
        new Date(incoming.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
          ? incoming.updatedAt
          : existing.updatedAt
    }),
    SHOPPING_MERGE_OPTIONS
  );

/**
 * Adds typed or recipe lines, merging each into a matching item on the current household's list.
 * Records kept for another household are not on it, so a new amount never lands on them.
 */
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
        sync: syncStateAfterEdit(options),
        updatedAt: timestamp
      } satisfies MobileShoppingItem;
    })
    .filter((item): item is MobileShoppingItem => item != null);
  const elsewhere = existingItems.filter((item) =>
    belongsToOtherHousehold(item, options.householdId)
  );

  if (elsewhere.length === 0) {
    return mergeShoppingItems(existingItems, incoming);
  }

  const onList = existingItems.filter(
    (item) => !belongsToOtherHousehold(item, options.householdId)
  );
  return [...mergeShoppingItems(onList, incoming), ...elsewhere];
};

export const setShoppingItemCheckedInList = (
  items: MobileShoppingItem[],
  id: string,
  checked: boolean,
  options: ShoppingMutationOptions
): MobileShoppingItem[] =>
  items.map((item) =>
    item.id === id && !belongsToOtherHousehold(item, options.householdId)
      ? {
          ...item,
          checked,
          checkedBy: checked ? (options.userId ?? LOCAL_SHOPPING_USER) : null,
          sync: syncStateAfterEdit(options, item),
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
            ...householdOf(item),
            lastError: message,
            status: "sync_failed"
          }
        }
      : item
  );

/**
 * Removes items: local-only items (or any item when the list does not sync) disappear, synced
 * items become dirty tombstones so the household list learns about the delete. Another
 * household's records are not on the list, so they stay.
 */
export const deleteShoppingItemsInList = (
  items: MobileShoppingItem[],
  ids: ReadonlySet<string>,
  options: ShoppingMutationOptions
): MobileShoppingItem[] => {
  const timestamp = options.now ?? new Date().toISOString();

  return items.flatMap((item) => {
    if (!ids.has(item.id) || belongsToOtherHousehold(item, options.householdId)) {
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
        sync: syncStateAfterEdit(options, item),
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

/**
 * Applies household items (last write wins), recording `householdId` as the one they came from
 * (and on unsent changes to them that don't name a household yet).
 */
export const applyRemoteShoppingItems = (
  localItems: MobileShoppingItem[],
  remoteItems: ShoppingItem[],
  householdId?: string
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
      // An unsent change that names no household, to an item this household has, is this
      // household's (e.g. its item checked off before changes recorded their household).
      if (householdId && needsPush(localItem) && !localItem.sync.householdId) {
        nextById.set(localItem.id, { ...localItem, sync: { ...localItem.sync, householdId } });
      }

      continue;
    }

    nextById.set(remoteItem.id, {
      ...remoteItem,
      createdAt: localItem?.createdAt ?? remoteItem.updatedAt,
      sync: {
        ...(householdId ? { householdId } : {}),
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
 * still-dirty version so the follow-up sync sends it. `householdId` is the household that
 * accepted them.
 */
export const markShoppingItemsSynced = (
  items: MobileShoppingItem[],
  pushedVersions: ReadonlyMap<string, string>,
  syncedAt: string,
  householdId?: string
): MobileShoppingItem[] =>
  items.map((item) =>
    pushedVersions.get(item.id) === item.updatedAt && !item.isDeleted
      ? {
          ...item,
          sync: {
            ...(householdId ? { householdId } : householdOf(item)),
            lastSyncedAt: syncedAt,
            status: "synced"
          }
        }
      : item
  );

/** Items waiting to be pushed to the household list (edits and delete tombstones). */
export const getSyncableDirtyItems = (items: MobileShoppingItem[]): MobileShoppingItem[] =>
  items.filter(needsPush);

/**
 * The list as `householdId` sees it: live items, without the records kept for another
 * household. Signed out (no household), every item on this device shows.
 */
export const getShoppingListItems = (
  items: MobileShoppingItem[],
  householdId: string | null | undefined
): MobileShoppingItem[] =>
  items.filter((item) => !item.isDeleted && !belongsToOtherHousehold(item, householdId));

/**
 * Unsent changes (edits and delete tombstones) that signed-in account `userId` may send to
 * `householdId`. Another household's wait on this device, untouched, until that household syncs
 * here again; so does another account's change that names no household (isAnotherAccountsChange).
 */
export const getPendingShoppingChanges = (
  items: MobileShoppingItem[],
  householdId: string,
  userId: string
): MobileShoppingItem[] =>
  items.filter(
    (item) =>
      needsPush(item) &&
      !belongsToOtherHousehold(item, householdId) &&
      !isAnotherAccountsChange(item, userId)
  );

/**
 * Records `householdId` (signed-in account `userId`'s, just confirmed) on unsent changes that
 * don't name a household yet: stored before items recorded one. Another account's item that
 * names none waits for that account (see isAnotherAccountsChange). With `from`, this account has
 * moved from that household, so its changes for it can only go to the new one now. Other
 * households' changes are left alone. Returns `items` itself when nothing changes.
 */
export const claimShoppingChanges = (
  items: MobileShoppingItem[],
  householdId: string,
  options: { from?: string | undefined; userId: string }
): MobileShoppingItem[] => {
  const claims = (item: MobileShoppingItem) =>
    needsPush(item) &&
    (item.sync.householdId
      ? options.from !== undefined && item.sync.householdId === options.from
      : !isAnotherAccountsChange(item, options.userId));

  return items.some(claims)
    ? items.map((item) => (claims(item) ? { ...item, sync: { ...item.sync, householdId } } : item))
    : items;
};

/**
 * Drops unsent changes kept for a household other than `householdId` (the one syncing now) whose
 * last change is more than 30 days old (see STALE_CHANGE_TTL_MS). The current household's
 * changes, ones that name no household (made signed out, or not claimed yet) and synced records
 * are never dropped. Returns `items` itself when nothing is dropped.
 */
export const pruneStaleShoppingRecords = (
  items: MobileShoppingItem[],
  householdId: string,
  now: number = Date.now()
): MobileShoppingItem[] => {
  const isStale = (item: MobileShoppingItem) =>
    needsPush(item) &&
    belongsToOtherHousehold(item, householdId) &&
    now - new Date(item.updatedAt).getTime() > STALE_CHANGE_TTL_MS;

  return items.some(isStale) ? items.filter((item) => !isStale(item)) : items;
};

/** FNV-1a over `text` from `seed`, in base 36. */
const fnv1a = (text: string, seed: number): string => {
  let hash = seed;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }

  return hash.toString(36).padStart(7, "0");
};

/**
 * The id a set-aside copy of item `id` gets once `householdId` refused it: derived from both, so
 * setting the same change aside again can never make a second copy.
 */
export const setAsideShoppingItemId = (id: string, householdId: string | undefined): string => {
  const key = `set-aside:${householdId ?? ""}:${id}`;
  return `shopping_aside_${fnv1a(key, 2_166_136_261)}${fnv1a(key, 3_735_928_559)}`;
};

/**
 * Unsent changes the household list refused because the item is stored in another household,
 * one this device can't name (they were stored before items recorded their household). An edited
 * item stays on this device as a local-only item under a new id (see setAsideShoppingItemId), so
 * it can never be sent in place of the other household's record. A deletion can't apply here, so
 * it is dropped.
 */
export const setAsideShoppingItems = (
  items: MobileShoppingItem[],
  ids: ReadonlySet<string>,
  householdId: string | undefined
): MobileShoppingItem[] => {
  if (ids.size === 0) {
    return items;
  }

  const copies = new Map<string, MobileShoppingItem>();

  for (const item of items) {
    if (ids.has(item.id) && !item.isDeleted) {
      const id = setAsideShoppingItemId(item.id, householdId);
      copies.set(id, { ...item, id, sync: { status: "local_only" } });
    }
  }

  return items.flatMap((item): MobileShoppingItem[] => {
    if (ids.has(item.id)) {
      const copy = item.isDeleted
        ? undefined
        : copies.get(setAsideShoppingItemId(item.id, householdId));
      return copy ? [copy] : [];
    }

    // An earlier copy of the same change: the new copy takes its place.
    return copies.has(item.id) ? [] : [item];
  });
};

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
      .map(({ sync: { householdId, ...sync }, ...item }) => ({
        ...item,
        sync: {
          ...sync,
          ...(typeof householdId === "string" && householdId ? { householdId } : {}),
          status:
            sync.status === "dirty" ||
            sync.status === "local_only" ||
            sync.status === "sync_failed" ||
            sync.status === "synced"
              ? sync.status
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
