import { useCallback, useMemo } from "react";

import { getLinkDishWebDb, IMPORT_QUEUE_STORE_NAME } from "../storage/linkdish-db";

import { emitDataChange } from "./change-feed";
import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

/**
 * Links or pasted text waiting to be imported — shared while offline, or queued in a batch.
 * A worker (the import page) takes the oldest `queued` item, marks it `processing`, then `done`
 * or `failed`. Items stuck in `processing` (tab closed mid-import) can be put back in the queue.
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
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

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

const patchItem = async (
  id: string,
  patch: (item: ImportQueueItem) => ImportQueueItem
): Promise<ImportQueueItem | undefined> => {
  const db = await getLinkDishWebDb();
  const existing = (await db.get(IMPORT_QUEUE_STORE_NAME, id)) as ImportQueueItem | undefined;

  if (!existing) {
    return undefined;
  }

  return writeItem({ ...patch(existing), updatedAt: new Date().toISOString() });
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

export const markImportProcessing = (id: string) =>
  patchItem(id, (item) => ({
    ...withoutError(item),
    attempts: item.attempts + 1,
    status: "processing"
  }));

export const markImportFailed = (id: string, error: string) =>
  patchItem(id, (item) => ({
    ...item,
    error: error.trim().slice(0, MAX_ERROR_LENGTH) || "This import didn't work.",
    status: "failed"
  }));

export const markImportDone = (id: string, result: { recipeId?: string | undefined } = {}) =>
  patchItem(id, (item) => ({
    ...withoutError(item),
    status: "done",
    ...(result.recipeId ? { recipeId: result.recipeId } : {})
  }));

export const retryImport = (id: string) =>
  patchItem(id, (item) => ({ ...withoutError(item), status: "queued" }));

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

/** Puts imports that have been `processing` for too long back in the queue. */
export async function recoverStaleImports(now: number = Date.now()): Promise<number> {
  const stale = (await getImportQueue()).filter(
    (item) => item.status === "processing" && now - Date.parse(item.updatedAt) > STALE_PROCESSING_MS
  );

  for (const item of stale) {
    await retryImport(item.id);
  }

  return stale.length;
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
