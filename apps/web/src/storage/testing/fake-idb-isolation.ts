/**
 * IndexedDB-like transaction isolation on top of the fake in `fake-idb.ts`, for tests that race
 * two "tabs" against one database. Test-only (never imported by app code). Mock `idb` with this
 * module instead of the plain fake:
 *
 *   vi.mock("idb", async () =>
 *     (await import("../../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule);
 *
 * It behaves exactly like the plain fake until a test calls `isolateFakeIdbTransactions()`.
 * It only calls the plain fake's shortcuts (`db.get`, `db.put`...), so it works whatever
 * transaction model `fake-idb.ts` has.
 */

import { fakeIdbModule } from "./fake-idb";

/** The parts of the plain fake's database this module builds on. */
interface FakeDatabase {
  count: (storeName: string) => Promise<number>;
  countFromIndex: (storeName: string, indexName: string, key: unknown) => Promise<number>;
  delete: (storeName: string, key: string) => Promise<void>;
  get: (storeName: string, key: string) => Promise<unknown>;
  getAll: (storeName: string) => Promise<unknown[]>;
  getAllFromIndex: (storeName: string, indexName: string, key?: unknown) => Promise<unknown[]>;
  getAllKeys: (storeName: string) => Promise<string[]>;
  objectStoreNames: { contains: (name: string) => boolean };
  put: (storeName: string, value: unknown) => Promise<unknown>;
  transaction: (storeNames: string | string[], mode?: IDBTransactionMode) => unknown;
}

interface IsolatedTransaction {
  /** Resolves once the transaction has committed. */
  finished: Promise<void>;
  mode: IDBTransactionMode;
  names: readonly string[];
  /** Resolves once every earlier transaction this one has to wait for has committed. */
  started: Promise<void>;
}

/** Transactions that have not committed yet, oldest first; `null` while isolation is off. */
let running: Set<IsolatedTransaction> | null = null;

/**
 * Turns isolation on (or off, with `false`) for every connection opened through this module;
 * `fakeIdb.reset()` leaves it as it is. While it is on, transactions are isolated like
 * IndexedDB's (e.g. two tabs' writes): one waits until every earlier overlapping transaction where
 * either writes has committed; each commits once no request is pending when control returns to
 * the event loop (a request after that throws TransactionInactiveError, a write in a readonly one
 * ReadOnlyError); and every shortcut (`db.get`, `db.put`...) is a transaction of its own. Commits
 * wait for a `setTimeout`, so fake timers would hold them back. Failed requests do not abort or
 * roll back.
 */
export function isolateFakeIdbTransactions(enabled = true): void {
  running = enabled ? new Set() : null;
}

const createIsolatedTransaction = (
  db: FakeDatabase,
  names: readonly string[],
  mode: IDBTransactionMode
) => {
  for (const name of names) {
    if (!db.objectStoreNames.contains(name)) {
      throw new DOMException(`No objectStore named ${name} in this database`, "NotFoundError");
    }
  }

  const transactions = running ?? new Set<IsolatedTransaction>();
  // Like IndexedDB: it waits for every earlier overlapping transaction where either one writes.
  const blockers = Array.from(transactions).filter(
    (other) =>
      (mode !== "readonly" || other.mode !== "readonly") &&
      other.names.some((name) => names.includes(name))
  );
  let commit: () => void = () => undefined;
  const transaction: IsolatedTransaction = {
    finished: new Promise<void>((resolve) => {
      commit = resolve;
    }),
    mode,
    names,
    started: Promise.all(blockers.map((other) => other.finished)).then(() => undefined)
  };
  let active = true;
  let pending = 0;
  transactions.add(transaction);

  // It commits when no request is pending once control returns to the event loop.
  const commitWhenIdle = () => {
    setTimeout(() => {
      if (active && pending === 0) {
        active = false;
        transactions.delete(transaction);
        commit();
      }
    }, 0);
  };

  // A request runs once the transaction has started, after the ones placed in it before.
  const request = <T>(run: () => Promise<T>, writes = false): Promise<T> => {
    if (!active) {
      throw new DOMException("The transaction has finished.", "TransactionInactiveError");
    }

    if (writes && mode === "readonly") {
      throw new DOMException("The transaction is read-only.", "ReadOnlyError");
    }

    pending += 1;
    const result = transaction.started.then(run);
    const settle = () => {
      pending -= 1;

      if (pending === 0) {
        commitWhenIdle();
      }
    };
    void result.then(settle, settle);
    return result;
  };

  const objectStore = (name: string) => {
    if (!names.includes(name)) {
      throw new DOMException(`${name} is not part of this transaction`, "NotFoundError");
    }

    return {
      clear: () =>
        request(async () => {
          const keys = await db.getAllKeys(name);
          await Promise.all(keys.map((key) => db.delete(name, key)));
        }, true),
      count: () => request(() => db.count(name)),
      delete: (key: string) => request(() => db.delete(name, key), true),
      get: (key: string) => request(() => db.get(name, key)),
      getAll: () => request(() => db.getAll(name)),
      getAllKeys: () => request(() => db.getAllKeys(name)),
      index: (indexName: string) => ({
        count: (key: unknown) => request(() => db.countFromIndex(name, indexName, key)),
        getAll: (key?: unknown) => request(() => db.getAllFromIndex(name, indexName, key))
      }),
      put: (value: unknown) => request(() => db.put(name, value), true)
    };
  };

  commitWhenIdle();

  return { done: transaction.finished, objectStore, store: objectStore(names[0] ?? "") };
};

/** The plain fake's database, with its transactions and shortcuts isolated while that is on. */
const isolating = (db: FakeDatabase) => {
  const shortcut = (storeName: string) =>
    createIsolatedTransaction(db, [storeName], "readwrite").objectStore(storeName);

  return {
    ...db,
    count: (storeName: string) => (running ? shortcut(storeName).count() : db.count(storeName)),
    countFromIndex: (storeName: string, indexName: string, key: unknown) =>
      running
        ? shortcut(storeName).index(indexName).count(key)
        : db.countFromIndex(storeName, indexName, key),
    delete: (storeName: string, key: string) =>
      running ? shortcut(storeName).delete(key) : db.delete(storeName, key),
    get: (storeName: string, key: string) =>
      running ? shortcut(storeName).get(key) : db.get(storeName, key),
    getAll: (storeName: string) => (running ? shortcut(storeName).getAll() : db.getAll(storeName)),
    getAllFromIndex: (storeName: string, indexName: string, key?: unknown) =>
      running
        ? shortcut(storeName).index(indexName).getAll(key)
        : db.getAllFromIndex(storeName, indexName, key),
    getAllKeys: (storeName: string) =>
      running ? shortcut(storeName).getAllKeys() : db.getAllKeys(storeName),
    put: (storeName: string, value: unknown) =>
      running ? shortcut(storeName).put(value) : db.put(storeName, value),
    transaction: (storeNames: string | string[], mode: IDBTransactionMode = "readonly") =>
      running
        ? createIsolatedTransaction(db, Array.isArray(storeNames) ? storeNames : [storeNames], mode)
        : db.transaction(storeNames, mode)
  };
};

/** Drop-in replacement for the `idb` module: the plain fake, isolated while that is on. */
export const isolatingFakeIdbModule = {
  ...fakeIdbModule,
  openDB: async (...args: Parameters<typeof fakeIdbModule.openDB>) => {
    const db: FakeDatabase = await fakeIdbModule.openDB(...args);
    return isolating(db);
  }
};
