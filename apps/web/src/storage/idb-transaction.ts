import { getLinkDishWebDb } from "./linkdish-db";

import type { LinkDishWebStoreName } from "./linkdish-db";
import type { IDBPTransaction } from "idb";

/**
 * One transaction over several stores of the `linkdish-web` database.
 *
 * Anything that spans stores (a collection and the recipes filed in it, a recipe and its scans, a
 * backup of everything) belongs in one transaction. A readwrite one lands completely or not at
 * all, and IndexedDB queues other readwrite transactions on those stores (another tab's too)
 * behind it, so no write lands between its reads and its writes. A readonly one reads every store
 * at the same moment: a write that starts meanwhile waits for it.
 */
export type LinkDishTransaction<Mode extends IDBTransactionMode> = IDBPTransaction<
  unknown,
  LinkDishWebStoreName[],
  Mode
>;

const abortQuietly = (tx: { abort(): void }): void => {
  try {
    tx.abort();
  } catch {
    // Already aborted by the failed request, or already finished.
  }
};

/**
 * Runs `work` in ONE transaction over `storeNames` and resolves with what it returns once the
 * transaction has committed, so change notifications sent afterwards only ever describe saved
 * data.
 *
 * `work` must only await requests of `tx`: awaiting anything else (a network call, a timer) lets
 * the transaction commit early. When `work` throws, because a request failed (a full device) or a
 * check of its own did, the transaction is aborted so nothing it wrote is kept in any store, and
 * the error is rethrown. A transaction that fails as it commits rejects as well.
 */
export async function runLinkDishTransaction<Result, Mode extends "readonly" | "readwrite">(
  storeNames: readonly LinkDishWebStoreName[],
  mode: Mode,
  work: (tx: LinkDishTransaction<Mode>) => Promise<Result>
): Promise<Result> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction([...storeNames], mode);
  const done = tx.done;
  // A failed request rejects `work`; keep `done` from also surfacing as an unhandled rejection.
  done.catch(() => undefined);
  let result: Result;

  try {
    result = await work(tx);
  } catch (error) {
    abortQuietly(tx);
    throw error;
  }

  await done;
  return result;
}
