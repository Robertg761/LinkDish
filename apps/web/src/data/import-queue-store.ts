import { useCallback, useMemo } from "react";

import { getLinkDishWebDb, IMPORT_QUEUE_STORE_NAME } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

import type { SaveRecipeInput } from "../features/library/saved-recipe-store";

/**
 * Links or pasted text waiting to be imported — shared while offline, or queued in a batch.
 * A worker (the import page) claims the oldest `queued` item — one transaction marks it
 * `processing` for that tab, so two tabs never take the same item — then marks it `done` or
 * `failed`. The worker renews its claim while it works; an item whose claim has lapsed (tab
 * closed mid-import) can be put back in the queue. Until another tab claims it, the tab that
 * lapsed (suspended rather than closed) may still take it back and finish it.
 *
 * An item whose import worked but whose recipe couldn't be kept yet (the cookbook filled up first)
 * waits with that recipe ({@link ImportQueuePendingSave}): the import is paid for, so the item is
 * only ever saved from then on, never imported again.
 */

export type ImportQueueStatus = "queued" | "processing" | "failed" | "done";

export interface ImportQueueItem {
  id: string;
  url?: string | undefined;
  text?: string | undefined;
  /**
   * With `text` only: the page the text came from (the one link in a pasted caption). It goes with
   * the text to the importer and becomes the recipe's source, as it does for text imported online.
   * Unlike `url`, it never makes the item a link import, and never merges it with one.
   */
  sourceUrl?: string | undefined;
  status: ImportQueueStatus;
  error?: string | undefined;
  /** The saved recipe produced by a `done` import. */
  recipeId?: string | undefined;
  /** Where the link came from (analytics): the share sheet or typed/pasted in the app. */
  source?: ImportQueueSource | undefined;
  attempts: number;
  /**
   * The tab working on a `processing` item (see {@link claimNextQueuedImport}). On a `queued`
   * item: the tab whose claim lapsed, which may still finish it until another tab claims it.
   */
  claimedBy?: string | undefined;
  /** When that tab last claimed or renewed the item. */
  claimedAt?: string | undefined;
  /**
   * The recipe this item's import produced, while it waits to be saved (see
   * {@link ImportQueuePendingSave}). Kept through claims, stale recovery, failure and Retry;
   * cleared once the item is done.
   */
  pendingSave?: ImportQueuePendingSave | undefined;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an import produced, kept on its item until the recipe is saved: the cookbook filled up
 * before it could be (another tab took the last free slot), or saving it didn't work. The import
 * was paid for then (the API counted it; a signed-out import spent the allowance), so a later
 * run saves exactly this rather than importing the link, and paying for it, again.
 */
export interface ImportQueuePendingSave extends Pick<
  SaveRecipeInput,
  "extraction" | "recipe" | "sourceUrl"
> {
  /** The import's analytics correlation id, which its save is reported under. */
  correlationId: string;
}

export type ImportQueueSource = "in_app" | "share_sheet";

export interface ImportQueueInput {
  url?: string | undefined;
  text?: string | undefined;
  /** Where `text` came from (see {@link ImportQueueItem.sourceUrl}); ignored without text. */
  sourceUrl?: string | undefined;
  source?: ImportQueueSource | undefined;
}

const MAX_TEXT_LENGTH = 20_000;
const MAX_ERROR_LENGTH = 300;
/**
 * How long a claim holds without being renewed. Longer than the longest import (two 2-minute
 * extraction requests, then the save), so a tab that is still working never loses its item.
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;
/** A working tab renews its claim this often. */
export const IMPORT_CLAIM_RENEW_MS = 30 * 1000;

export class ImportQueueValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImportQueueValidationError";
  }
}

const normalizeUrl = (url: string | undefined): string | undefined => {
  const trimmed = url?.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ImportQueueValidationError("Only web links (http or https) can be imported.");
    }

    return parsed.toString();
  } catch (error) {
    if (error instanceof ImportQueueValidationError) {
      throw error;
    }

    throw new ImportQueueValidationError("That doesn't look like a recipe link.");
  }
};

/** Mirrors the length limit of httpUrlSchema in @linkdish/recipe-domain. */
const MAX_SOURCE_URL_LENGTH = 2_048;

/**
 * A pasted text's source link, as the importer sends it (trimmed, otherwise as given, so the
 * recipe gets the same id it would have online). Only a link the API takes (httpUrlSchema: a web
 * link without a sign-in in it, 2,048 characters at most); anything else is left off rather than
 * keeping the text out of the queue, or failing it on every try.
 */
const toSourceUrl = (sourceUrl: string | undefined): string | undefined => {
  const trimmed = sourceUrl?.trim();

  if (!trimmed || trimmed.length > MAX_SOURCE_URL_LENGTH) {
    return undefined;
  }

  try {
    const { password, protocol, username } = new URL(trimmed);
    return (protocol === "http:" || protocol === "https:") && !username && !password
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
};

const withoutError = (item: ImportQueueItem): ImportQueueItem => {
  const next = { ...item };
  delete next.error;
  return next;
};

const withoutClaim = (item: ImportQueueItem): ImportQueueItem => {
  const next = { ...item };
  delete next.claimedBy;
  delete next.claimedAt;
  return next;
};

const withoutPendingSave = (item: ImportQueueItem): ImportQueueItem => {
  const next = { ...item };
  delete next.pendingSave;
  return next;
};

/**
 * Whether `owner` may still write to the item: it holds the claim, or its claim lapsed and the item
 * went back in the queue but no other tab has claimed it since (so its result still counts).
 */
const isClaimedBy = (item: ImportQueueItem, owner: string): boolean =>
  (item.status === "processing" || item.status === "queued") && item.claimedBy === owner;

/** The item held by `owner` from `now`: a renewed claim, or a lapsed one taken back. */
const heldBy = (item: ImportQueueItem, owner: string | undefined, now = Date.now()) =>
  owner === undefined
    ? item
    : {
        ...item,
        claimedAt: new Date(now).toISOString(),
        claimedBy: owner,
        status: "processing" as const
      };

/** A `processing` item nobody has renewed lately (items from before claims: their last write). */
const isClaimStale = (item: ImportQueueItem, now: number): boolean =>
  item.status === "processing" &&
  now - Date.parse(item.claimedAt ?? item.updatedAt) > STALE_PROCESSING_MS;

const sortByCreatedAt = (items: readonly ImportQueueItem[]): ImportQueueItem[] =>
  [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

/**
 * Items that only need saving first (they cost no import, so an older link that would pause the
 * queue for want of one never holds them up), then the oldest.
 */
const sortByClaimOrder = (items: readonly ImportQueueItem[]): ImportQueueItem[] =>
  [...items].sort(
    (a, b) =>
      Number(Boolean(b.pendingSave)) - Number(Boolean(a.pendingSave)) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  );

export async function getImportQueue(): Promise<ImportQueueItem[]> {
  const db = await getLinkDishWebDb();
  return sortByCreatedAt((await db.getAll(IMPORT_QUEUE_STORE_NAME)) as ImportQueueItem[]);
}

const importQueueResource = createResourceStore<ImportQueueItem[]>({
  applyLocalChange: (current, change) => {
    const next = upsertById(
      current,
      change.upserted as ImportQueueItem[] | undefined,
      change.deletedIds,
      (item) => item.id
    );
    return next === current ? current : sortByCreatedAt(next);
  },
  initial: [],
  load: getImportQueue,
  topic: "importQueue"
});

/** The reads a queue transaction makes before it writes. */
interface ImportQueueReader {
  get(id: string): Promise<unknown>;
  getAll(): Promise<unknown[]>;
  index(name: "status"): { getAll(status: ImportQueueStatus): Promise<unknown[]> };
}

/**
 * Reads items and writes the changed ones in one readwrite transaction. IndexedDB runs those one
 * at a time (across tabs too), so nothing changes the items between the read and the write.
 * `change` returns the items to write; they get a fresh `updatedAt`.
 */
const updateInTransaction = async (
  read: (store: ImportQueueReader) => Promise<ImportQueueItem[]>,
  change: (items: ImportQueueItem[]) => ImportQueueItem[]
): Promise<ImportQueueItem[]> => {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(IMPORT_QUEUE_STORE_NAME, "readwrite");
  const updatedAt = new Date().toISOString();
  const written = change(await read(tx.store)).map((item) => ({ ...item, updatedAt }));
  await Promise.all([...written.map((item) => tx.store.put(item)), tx.done]);

  if (written.length) {
    emitDataChange({ topic: "importQueue", upserted: written });
  }

  return written;
};

/** Like {@link updateInTransaction}, but deletes the items `pick` returns. Returns those. */
const deleteInTransaction = async (
  read: (store: ImportQueueReader) => Promise<ImportQueueItem[]>,
  pick: (items: ImportQueueItem[]) => ImportQueueItem[]
): Promise<ImportQueueItem[]> => {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(IMPORT_QUEUE_STORE_NAME, "readwrite");
  const deleted = pick(await read(tx.store));
  await Promise.all([...deleted.map((item) => tx.store.delete(item.id)), tx.done]);

  if (deleted.length) {
    emitDataChange({ deletedIds: deleted.map((item) => item.id), topic: "importQueue" });
  }

  return deleted;
};

const readItem = async (store: ImportQueueReader, id: string): Promise<ImportQueueItem[]> => {
  const item = (await store.get(id)) as ImportQueueItem | undefined;
  return item ? [item] : [];
};

/** Whether a change still applies to the item as it is when the change runs. */
type ItemGuard = (item: ImportQueueItem) => boolean;

/**
 * With `owner`, only while that tab still holds the item's claim: a worker never writes over an
 * item another tab claimed (or that was finished or removed) while it worked. Any item otherwise.
 */
const heldOnlyBy =
  (owner: string | undefined): ItemGuard =>
  (item) =>
    owner === undefined || isClaimedBy(item, owner);

/**
 * Changes one item if `applies` to it: both are decided in the transaction that writes it.
 * Undefined when the item is gone or the change no longer applies.
 */
const patchItem = async (
  id: string,
  patch: (item: ImportQueueItem) => ImportQueueItem,
  applies: ItemGuard
): Promise<ImportQueueItem | undefined> => {
  const [written] = await updateInTransaction(
    (store) => readItem(store, id),
    (items) => items.filter(applies).map(patch)
  );
  return written;
};

/** A checked, trimmed {@link ImportQueueInput}. Throws {@link ImportQueueValidationError}. */
const toEntry = (input: ImportQueueInput): ImportQueueInput => {
  const url = normalizeUrl(input.url);
  const text = input.text?.trim().slice(0, MAX_TEXT_LENGTH) || undefined;

  if (!url && !text) {
    throw new ImportQueueValidationError("Add a recipe link or some recipe text.");
  }

  // A link import is its own source; only pasted text keeps where it came from.
  const sourceUrl = url ? undefined : toSourceUrl(input.sourceUrl);

  return {
    ...(url ? { url } : {}),
    ...(text ? { text } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(input.source ? { source: input.source } : {})
  };
};

/**
 * Adds links and/or text to the queue, all or nothing (one invalid entry adds none). Re-adding a
 * link that is still waiting (or failed) returns the existing item — a failed one goes back in the
 * queue. The duplicate lookup and the writes are one readwrite transaction, so two tabs adding the
 * same link at once still queue it once (and a batch never queues a link twice). Pasted text is
 * always a new item, whichever page it came from: online, each paste is its own import too.
 * Returns one item per input, in order.
 */
export async function enqueueImports(
  inputs: readonly ImportQueueInput[]
): Promise<ImportQueueItem[]> {
  const entries = inputs.map(toEntry);

  if (!entries.length) {
    return [];
  }

  const now = new Date().toISOString();
  let items: ImportQueueItem[] = [];
  const written = await updateInTransaction(
    async (store) =>
      entries.some((entry) => entry.url)
        ? sortByCreatedAt((await store.getAll()) as ImportQueueItem[])
        : [],
    (queue) => {
      // The oldest unfinished item for each link, as it will be once this transaction commits.
      const byUrl = new Map<string, ImportQueueItem>();
      const changed = new Map<string, ImportQueueItem>();

      for (const item of queue) {
        if (item.url && item.status !== "done" && !byUrl.has(item.url)) {
          byUrl.set(item.url, item);
        }
      }

      items = entries.map((entry) => {
        const active = entry.url ? byUrl.get(entry.url) : undefined;
        const item: ImportQueueItem =
          active?.status === "failed"
            ? { ...withoutClaim(withoutError(active)), status: "queued" }
            : (active ?? {
                attempts: 0,
                createdAt: now,
                id: crypto.randomUUID(),
                status: "queued",
                updatedAt: now,
                ...entry
              });

        if (item !== active) {
          changed.set(item.id, item);

          if (item.url) {
            byUrl.set(item.url, item);
          }
        }

        return item;
      });

      return [...changed.values()];
    }
  );
  const saved = new Map(written.map((item) => [item.id, item]));
  return items.map((item) => saved.get(item.id) ?? item);
}

/** Adds a link and/or text to the queue (see {@link enqueueImports}). */
export async function enqueueImport(input: ImportQueueInput): Promise<ImportQueueItem> {
  const [item] = await enqueueImports([input]);
  return item!;
}

/*
 * The status changes below take an optional `owner`: a worker passes its tab id so the change
 * applies only while it still holds the item's claim (it returns undefined otherwise).
 */

/** Counts an import attempt; the item is `processing`. */
export const markImportProcessing = (id: string, owner?: string) =>
  patchItem(
    id,
    (item) =>
      heldBy({ ...withoutError(item), attempts: item.attempts + 1, status: "processing" }, owner),
    heldOnlyBy(owner)
  );

/**
 * With `pendingSave`, the import worked but saving its recipe didn't: the item keeps the recipe,
 * so Retry saves it rather than importing it again. An item that already had one keeps it.
 */
export const markImportFailed = (
  id: string,
  error: string,
  owner?: string,
  pendingSave?: ImportQueuePendingSave
) =>
  patchItem(
    id,
    (item) => ({
      ...withoutClaim(item),
      error: error.trim().slice(0, MAX_ERROR_LENGTH) || "This import didn't work.",
      status: "failed",
      ...(pendingSave ? { pendingSave } : {})
    }),
    heldOnlyBy(owner)
  );

/** The recipe is saved: it no longer waits on the item (see {@link ImportQueuePendingSave}). */
export const markImportDone = (
  id: string,
  result: { recipeId?: string | undefined } = {},
  owner?: string
) =>
  patchItem(
    id,
    (item) => ({
      ...withoutClaim(withoutError(withoutPendingSave(item))),
      status: "done",
      ...(result.recipeId ? { recipeId: result.recipeId } : {})
    }),
    heldOnlyBy(owner)
  );

/**
 * Puts an item back in the queue: one its worker (`owner`) lets go of, or — without `owner`, as
 * the Retry button does — a failed one. Undefined when the item is no longer failed by the time
 * this runs (another tab retried it and may be importing it already), so it never takes an item
 * away from the tab working on it.
 */
export const retryImport = (id: string, owner?: string) =>
  patchItem(
    id,
    (item) => ({ ...withoutClaim(withoutError(item)), status: "queued" }),
    owner === undefined ? (item) => item.status === "failed" : heldOnlyBy(owner)
  );

/**
 * Puts an item its worker (`owner`) imported but couldn't save back in the queue with the recipe
 * (see {@link ImportQueuePendingSave}). The recipe is stored in the same write that lets the item
 * go, so no run can take the link back up without it and import it again.
 */
export const holdImportForSave = (
  id: string,
  pendingSave: ImportQueuePendingSave,
  owner?: string
) =>
  patchItem(
    id,
    (item) => ({ ...withoutClaim(withoutError(item)), pendingSave, status: "queued" }),
    heldOnlyBy(owner)
  );

/**
 * Takes the next waiting item for `owner` (this tab's id): one only waiting to be saved, else the
 * oldest. One readwrite transaction finds it and marks it `processing`, so two tabs working
 * through the queue never take the same item. Undefined when nothing is waiting.
 */
export async function claimNextQueuedImport(
  owner: string,
  now: number = Date.now()
): Promise<ImportQueueItem | undefined> {
  const claimedAt = new Date(now).toISOString();
  const [claimed] = await updateInTransaction(
    async (store) =>
      sortByClaimOrder((await store.index("status").getAll("queued")) as ImportQueueItem[]),
    ([next]) =>
      next ? [{ ...withoutError(next), claimedAt, claimedBy: owner, status: "processing" }] : []
  );
  return claimed;
}

/**
 * Keeps `owner`'s claim on an item it is still working on (taking it back if the claim lapsed and
 * nobody else has claimed it). Undefined once another tab has it, or it is finished or removed.
 */
export const renewImportClaim = (id: string, owner: string, now: number = Date.now()) =>
  patchItem(id, (item) => heldBy(item, owner, now), heldOnlyBy(owner));

/**
 * Removes an item unless a tab is importing it right now. Its status is read in the transaction
 * that deletes it, so a row that still showed it waiting or failed never pulls an import out from
 * under the tab working on it. False when the item was kept for that reason; true once it is gone.
 */
export async function removeImportQueueItem(id: string): Promise<boolean> {
  let kept = false;
  await deleteInTransaction(
    (store) => readItem(store, id),
    (items) => {
      kept = items.some((item) => item.status === "processing");
      return kept ? [] : items;
    }
  );
  return !kept;
}

/** Deletes every finished (`done`) item. Returns how many were removed. */
export async function clearFinishedImports(): Promise<number> {
  const cleared = await deleteInTransaction(
    async (store) => (await store.index("status").getAll("done")) as ImportQueueItem[],
    (items) => items
  );
  return cleared.length;
}

/** The oldest item still waiting, if any. */
export async function getNextQueuedImport(): Promise<ImportQueueItem | undefined> {
  return (await getImportQueue()).find((item) => item.status === "queued");
}

/**
 * Puts `processing` items whose claim has lapsed (their tab closed or crashed mid-import) back in
 * the queue. Each claim is checked inside the same transaction that re-queues it, so an item whose
 * tab is still renewing its claim is never taken away. The item keeps `claimedBy`: should that tab
 * only have been suspended, it can still finish the item until another tab claims it. A recipe
 * waiting to be saved stays with it.
 */
export async function recoverStaleImports(now: number = Date.now()): Promise<number> {
  const recovered = await updateInTransaction(
    async (store) => (await store.index("status").getAll("processing")) as ImportQueueItem[],
    (items) =>
      items
        .filter((item) => isClaimStale(item, now))
        .map((item) => {
          const next: ImportQueueItem = { ...withoutError(item), status: "queued" };
          delete next.claimedAt;
          return next;
        })
  );
  return recovered.length;
}

export interface ImportQueueView {
  error: unknown;
  failedCount: number;
  items: ImportQueueItem[];
  /** Items still waiting or in progress. */
  pendingCount: number;
  retry: () => void;
  status: "loading" | "ready" | "error";
}

export function useImportQueue(): ImportQueueView {
  const snapshot = useResource(importQueueResource);
  const retry = useCallback(() => {
    void importQueueResource.load({ force: true });
  }, []);

  return useMemo(() => {
    let pendingCount = 0;
    let failedCount = 0;

    for (const item of snapshot.data) {
      if (item.status === "queued" || item.status === "processing") {
        pendingCount += 1;
      } else if (item.status === "failed") {
        failedCount += 1;
      }
    }

    return {
      error: snapshot.error,
      failedCount,
      items: snapshot.data,
      pendingCount,
      retry,
      status: toViewStatus(snapshot.status)
    };
  }, [retry, snapshot]);
}

export const loadImportQueue = (options?: { force?: boolean }): Promise<void> =>
  importQueueResource.load(options);

export const getImportQueueSnapshot = () => importQueueResource.getSnapshot();

export function resetImportQueueStoreForTests(): void {
  importQueueResource.reset();
}
