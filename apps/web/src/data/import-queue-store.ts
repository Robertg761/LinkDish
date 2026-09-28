import { useCallback, useMemo } from "react";

import { getLinkDishWebDb, IMPORT_QUEUE_STORE_NAME } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

/**
 * Links or pasted text waiting to be imported — shared while offline, or queued in a batch.
 * A worker (the import page) claims the oldest `queued` item — one transaction marks it
 * `processing` for that tab, so two tabs never take the same item — then marks it `done` or
 * `failed`. The worker renews its claim while it works; an item whose claim has lapsed (tab
 * closed mid-import) can be put back in the queue. Until another tab claims it, the tab that
 * lapsed (suspended rather than closed) may still take it back and finish it.
 */

export type ImportQueueStatus = "queued" | "processing" | "failed" | "done";

export interface ImportQueueItem {
  id: string;
  url?: string | undefined;
  text?: string | undefined;
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
  createdAt: string;
  updatedAt: string;
}

export type ImportQueueSource = "in_app" | "share_sheet";

export interface ImportQueueInput {
  url?: string | undefined;
  text?: string | undefined;
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

const writeItem = async (item: ImportQueueItem): Promise<ImportQueueItem> => {
  const db = await getLinkDishWebDb();
  await db.put(IMPORT_QUEUE_STORE_NAME, item);
  emitDataChange({ topic: "importQueue", upserted: [item] });
  return item;
};

/** The reads a queue transaction makes before it writes. */
interface ImportQueueReader {
  get(id: string): Promise<unknown>;
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

const readItem = async (store: ImportQueueReader, id: string): Promise<ImportQueueItem[]> => {
  const item = (await store.get(id)) as ImportQueueItem | undefined;
  return item ? [item] : [];
};

/**
 * Changes one item. With `owner`, only while that tab still holds the item's claim: a worker
 * never writes over an item another tab claimed (or that was finished or removed) while it worked.
 */
const patchItem = async (
  id: string,
  patch: (item: ImportQueueItem) => ImportQueueItem,
  owner?: string
): Promise<ImportQueueItem | undefined> => {
  const [written] = await updateInTransaction(
    (store) => readItem(store, id),
    (items) => items.filter((item) => owner === undefined || isClaimedBy(item, owner)).map(patch)
  );
  return written;
};

/**
 * Adds a link and/or text to the queue. Re-adding a link that is still waiting (or failed)
 * returns the existing item — a failed one goes back in the queue.
 */
export async function enqueueImport(input: ImportQueueInput): Promise<ImportQueueItem> {
  const url = normalizeUrl(input.url);
  const text = input.text?.trim().slice(0, MAX_TEXT_LENGTH) || undefined;

  if (!url && !text) {
    throw new ImportQueueValidationError("Add a recipe link or some recipe text.");
  }

  if (url) {
    const active = (await getImportQueue()).find(
      (item) => item.url === url && item.status !== "done"
    );

    if (active) {
      return active.status === "failed" ? ((await retryImport(active.id)) ?? active) : active;
    }
  }

  const now = new Date().toISOString();
  return writeItem({
    attempts: 0,
    createdAt: now,
    id: crypto.randomUUID(),
    status: "queued",
    updatedAt: now,
    ...(url ? { url } : {}),
    ...(text ? { text } : {}),
    ...(input.source ? { source: input.source } : {})
  });
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
    owner
  );

export const markImportFailed = (id: string, error: string, owner?: string) =>
  patchItem(
    id,
    (item) => ({
      ...withoutClaim(item),
      error: error.trim().slice(0, MAX_ERROR_LENGTH) || "This import didn't work.",
      status: "failed"
    }),
    owner
  );

export const markImportDone = (
  id: string,
  result: { recipeId?: string | undefined } = {},
  owner?: string
) =>
  patchItem(
    id,
    (item) => ({
      ...withoutClaim(withoutError(item)),
      status: "done",
      ...(result.recipeId ? { recipeId: result.recipeId } : {})
    }),
    owner
  );

/** Puts an item back in the queue (a failed one, or one its worker let go of). */
export const retryImport = (id: string, owner?: string) =>
  patchItem(id, (item) => ({ ...withoutClaim(withoutError(item)), status: "queued" }), owner);

/**
 * Takes the oldest waiting item for `owner` (this tab's id): one readwrite transaction finds it
 * and marks it `processing`, so two tabs working through the queue never take the same item.
 * Undefined when nothing is waiting.
 */
export async function claimNextQueuedImport(
  owner: string,
  now: number = Date.now()
): Promise<ImportQueueItem | undefined> {
  const claimedAt = new Date(now).toISOString();
  const [claimed] = await updateInTransaction(
    async (store) =>
      sortByCreatedAt((await store.index("status").getAll("queued")) as ImportQueueItem[]),
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
  patchItem(id, (item) => heldBy(item, owner, now), owner);

export async function removeImportQueueItem(id: string): Promise<void> {
  const db = await getLinkDishWebDb();
  await db.delete(IMPORT_QUEUE_STORE_NAME, id);
  emitDataChange({ deletedIds: [id], topic: "importQueue" });
}

/** Deletes every finished (`done`) item. Returns how many were removed. */
export async function clearFinishedImports(): Promise<number> {
  const finished = (await getImportQueue()).filter((item) => item.status === "done");

  if (!finished.length) {
    return 0;
  }

  const db = await getLinkDishWebDb();
  const tx = db.transaction(IMPORT_QUEUE_STORE_NAME, "readwrite");
  const store = tx.objectStore(IMPORT_QUEUE_STORE_NAME);
  await Promise.all([...finished.map((item) => store.delete(item.id)), tx.done]);
  emitDataChange({ deletedIds: finished.map((item) => item.id), topic: "importQueue" });
  return finished.length;
}

/** The oldest item still waiting, if any. */
export async function getNextQueuedImport(): Promise<ImportQueueItem | undefined> {
  return (await getImportQueue()).find((item) => item.status === "queued");
}

/**
 * Puts `processing` items whose claim has lapsed (their tab closed or crashed mid-import) back in
 * the queue. Each claim is checked inside the same transaction that re-queues it, so an item whose
 * tab is still renewing its claim is never taken away. The item keeps `claimedBy`: should that tab
 * only have been suspended, it can still finish the item until another tab claims it.
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
