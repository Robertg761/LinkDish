import { getLinkDishWebDb, type LinkDishWebStoreName } from "./linkdish-db";

/**
 * Read-modify-write helpers for the `linkdish-web` database.
 *
 * A read in one transaction followed by a write in another lets two tabs (or two handlers in one
 * tab) read the same record and then each write a whole replacement, so the later write silently
 * drops the earlier one's change. IndexedDB serializes readwrite transactions on the same store,
 * so doing the read and the write in ONE readwrite transaction makes the updates queue up instead.
 *
 * The update callbacks must be synchronous: awaiting anything other than a request of the same
 * transaction lets it auto-commit before the write, which would bring the race back.
 */

/**
 * Reads the record under `key`, passes it (or `undefined`) to `update`, and puts what `update`
 * returns, all in one readwrite transaction. Returning `undefined` writes nothing. Resolves with
 * the written record (or `undefined`) once the transaction has committed.
 */
export async function updateStoredRecord<Stored>(
  storeName: LinkDishWebStoreName,
  key: string,
  update: (current: Stored | undefined) => Stored | undefined
): Promise<Stored | undefined> {
  const db = await getLinkDishWebDb();
  const tx = db.transaction(storeName, "readwrite");
  const done = tx.done;
  // A failed request rejects below; keep `done` from also surfacing as an unhandled rejection.
  done.catch(() => undefined);
  const store = tx.objectStore(storeName);
  const current = (await store.get(key)) as Stored | undefined;
  // Nothing is pending while `update` runs, so a throw here commits the transaction unchanged.
  const next = update(current);

  if (next === undefined) {
    await done;
    return undefined;
  }

  await Promise.all([store.put(next), done]);
  return next;
}
