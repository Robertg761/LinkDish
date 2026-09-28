/**
 * Helpers for tests that race two "tabs" on one database (test-only, never imported by app code).
 * The tab itself is a fresh copy of the app modules, imported after `vi.resetModules()` by the
 * test (dynamic imports resolve against the test file), while `idb` stays mocked by the one shared
 * fake database; see `fake-idb-isolation.ts` for the IndexedDB-like transaction isolation.
 */

import { fakeIdb } from "./fake-idb";

export interface FakeBroadcastChannel {
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
}

/** Two BroadcastChannel ends: what one tab posts, the other hears (asynchronously). */
export const createChannelPair = (): [FakeBroadcastChannel, FakeBroadcastChannel] => {
  const ends: FakeBroadcastChannel[] = [];
  const end = (index: number): FakeBroadcastChannel => ({
    close: () => undefined,
    onmessage: null,
    postMessage: (message) => {
      setTimeout(() => ends[1 - index]?.onmessage?.({ data: message } as MessageEvent), 0);
    }
  });
  ends.push(end(0), end(1));
  return [ends[0]!, ends[1]!];
};

type Method = (...args: never[]) => unknown;

/** A database connection as the fake hands it out: methods that are plain, replaceable props. */
type FakeConnection = object;

interface FakeStore {
  get: (key: string) => Promise<unknown>;
}

interface FakeTransaction {
  objectStore: (name: string) => FakeStore;
  store: FakeStore;
}

const methodsOf = (connection: FakeConnection) =>
  connection as unknown as Record<string, Method | undefined>;

/** Resolves once `connection` next starts a transaction (a `transaction()` call or a shortcut). */
const nextTransaction = (connection: FakeConnection): Promise<void> =>
  new Promise((resolve) => {
    const methods = methodsOf(connection);
    const originals = new Map<string, Method>();
    const restore = () => {
      for (const [name, original] of originals) {
        methods[name] = original;
      }
    };

    for (const name of ["transaction", "get", "getAll", "getAllKeys", "put", "delete", "count"]) {
      const original = methods[name];

      if (typeof original !== "function") {
        continue;
      }

      originals.set(name, original);
      methods[name] = ((...args: never[]) => {
        const result = original.apply(connection, args);
        restore();
        resolve();
        return result;
      }) as Method;
    }
  });

/**
 * Lets another tab's write land at the worst moment: right after this tab's next read of `key`
 * in `storeName` (through `connection`, as a shortcut or inside a transaction) answers, `write`
 * starts in the other tab (`otherConnection`), and this tab only continues once that write has
 * opened its transaction. Where this tab reads and writes in separate transactions, the other
 * tab's write then lands in between; where it reads and writes in one, the other tab's write waits
 * for it. Resolves with what `write` resolves with.
 */
export function writeInOtherTabAfterNextRead<Result>(
  connection: FakeConnection,
  storeName: string,
  key: string,
  otherConnection: FakeConnection,
  write: () => Promise<Result>
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const methods = methodsOf(connection);
    const originalGet = methods.get as (storeName: string, key: string) => Promise<unknown>;
    const originalTransaction = methods.transaction as (...args: unknown[]) => FakeTransaction;
    let fired = false;

    const afterRead = async <Value>(value: Value): Promise<Value> => {
      if (!fired) {
        fired = true;
        methods.get = originalGet as Method;
        methods.transaction = originalTransaction as Method;
        const started = nextTransaction(otherConnection);
        write().then(resolve, reject);
        await started;
      }

      return value;
    };

    const watch = (name: string, store: FakeStore): FakeStore =>
      name === storeName
        ? {
            ...store,
            get: (readKey: string) =>
              readKey === key ? store.get(readKey).then(afterRead) : store.get(readKey)
          }
        : store;

    methods.get = ((readStore: string, readKey: string) =>
      readStore === storeName && readKey === key
        ? originalGet.call(connection, readStore, readKey).then(afterRead)
        : originalGet.call(connection, readStore, readKey)) as Method;
    methods.transaction = ((...args: unknown[]) => {
      const tx = originalTransaction.apply(connection, args);
      const names = Array.isArray(args[0]) ? (args[0] as string[]) : [args[0] as string];

      return {
        ...tx,
        objectStore: (name: string) => watch(name, tx.objectStore(name)),
        store: watch(names[0] ?? "", tx.store)
      };
    }) as Method;
  });
}

/**
 * Like {@link writeInOtherTabAfterNextRead}, for a read of a whole store: right after the next
 * `getAll` of `storeName` (in any tab, as a shortcut or inside a transaction) has read the store,
 * `write` starts in the other tab (`otherConnection`), and that read only answers once the write
 * has opened its transaction. Resolves with what `write` resolves with.
 */
export function writeInOtherTabAfterNextGetAll<Result>(
  storeName: string,
  otherConnection: FakeConnection,
  write: () => Promise<Result>
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    fakeIdb.afterNextGetAll(storeName, async () => {
      const started = nextTransaction(otherConnection);
      write().then(resolve, reject);
      await started;
    });
  });
}
