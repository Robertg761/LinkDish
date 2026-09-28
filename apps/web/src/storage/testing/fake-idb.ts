/**
 * A small Map-backed stand-in for the parts of `idb` LinkDish uses. Test-only (never imported by
 * app code). Use it from a test with:
 *
 *   vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
 *
 * It models object stores with key paths and indexes, multi-store transactions with `done`,
 * the upgrade callback (including its versionchange transaction), and `abort()` rolling the whole
 * upgrade back — enough to test migrations without fake-indexeddb.
 */

interface FakeStoreDefinition {
  indexes: Map<string, string>;
  keyPath: string;
}

interface FakeOpenCall {
  name: string;
  version: number | undefined;
}

interface FakeIdbState {
  blockedOnce: boolean;
  callbacks: FakeOpenCallbacks | null;
  failPuts: Map<string, Error>;
  definitions: Map<string, FakeStoreDefinition>;
  failNextOpen: Error | null;
  /** The next open waits for this (storage that is slow to answer). */
  openHold: Promise<void> | null;
  oldVersion: number;
  openCalls: FakeOpenCall[];
  records: Map<string, Map<string, unknown>>;
}

const state: FakeIdbState = {
  blockedOnce: false,
  callbacks: null,
  failPuts: new Map(),
  definitions: new Map(),
  failNextOpen: null,
  openHold: null,
  oldVersion: 0,
  openCalls: [],
  records: new Map()
};

const clone = <T>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

const readPath = (value: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, value);

const requireStore = (name: string) => {
  const definition = state.definitions.get(name);
  const records = state.records.get(name);

  if (!definition || !records) {
    throw new DOMException(`No objectStore named ${name} in this database`, "NotFoundError");
  }

  return { definition, records };
};

const tick = async <T>(run: () => T): Promise<T> => {
  // With isolation on, a transaction's requests wait until the transaction has started.
  await (placingRequestIn?.started ?? Promise.resolve());
  return run();
};

const createStoreApi = (name: string, track: <T>(promise: Promise<T>) => Promise<T>) => {
  const indexApi = (indexName: string) => ({
    count: (key: unknown) =>
      track(
        tick(() => {
          const { definition, records } = requireStore(name);
          const keyPath = definition.indexes.get(indexName);

          if (!keyPath) {
            throw new DOMException(`No index named ${indexName}`, "NotFoundError");
          }

          return Array.from(records.values()).filter((record) => readPath(record, keyPath) === key)
            .length;
        })
      ),
    getAll: (key?: unknown) =>
      track(
        tick(() => {
          const { definition, records } = requireStore(name);
          const keyPath = definition.indexes.get(indexName) ?? indexName;

          return Array.from(records.values())
            .filter((record) => key === undefined || readPath(record, keyPath) === key)
            .map(clone);
        })
      )
  });

  return {
    clear: () => track(tick(() => requireStore(name).records.clear())),
    count: () => track(tick(() => requireStore(name).records.size)),
    delete: (key: string) =>
      track(
        tick(() => {
          requireStore(name).records.delete(String(key));
        })
      ),
    get: (key: string) => track(tick(() => clone(requireStore(name).records.get(String(key))))),
    getAll: () => track(tick(() => Array.from(requireStore(name).records.values()).map(clone))),
    getAllKeys: () => track(tick(() => Array.from(requireStore(name).records.keys()))),
    index: indexApi,
    put: (value: unknown) =>
      track(
        tick(() => {
          const { definition, records } = requireStore(name);
          const key = readPath(value, definition.keyPath);
          const failure = state.failPuts.get(name);

          if (failure) {
            state.failPuts.delete(name);
            throw failure;
          }

          if (typeof key !== "string" && typeof key !== "number") {
            throw new DOMException("Missing key path value", "DataError");
          }

          records.set(String(key), clone(value));
          return key;
        })
      )
  };
};

const untracked = <T>(promise: Promise<T>) => promise;

/* ------------------------------------------------------------------------------------------------
 * Opt-in transaction isolation (see `fakeIdb.isolateTransactions`)
 * ---------------------------------------------------------------------------------------------- */

interface FakeIsolatedTransaction {
  /** Resolves once the transaction has committed. */
  finished: Promise<void>;
  mode: IDBTransactionMode;
  names: readonly string[];
  /** Resolves once every earlier transaction this one has to wait for has committed. */
  started: Promise<void>;
}

/** Transactions that have not committed yet, oldest first; `null` while isolation is off. */
let isolatedTransactions: Set<FakeIsolatedTransaction> | null = null;
/** The transaction a request is being placed in right now (read by `tick`). */
let placingRequestIn: FakeIsolatedTransaction | null = null;

const createIsolatedTransaction = (names: readonly string[], mode: IDBTransactionMode) => {
  const running = isolatedTransactions ?? new Set<FakeIsolatedTransaction>();
  // Like IndexedDB: it waits for every earlier overlapping transaction where either one writes.
  const blockers = Array.from(running).filter(
    (other) =>
      (mode !== "readonly" || other.mode !== "readonly") &&
      other.names.some((name) => names.includes(name))
  );
  let commit: () => void = () => undefined;
  const transaction: FakeIsolatedTransaction = {
    finished: new Promise<void>((resolve) => {
      commit = resolve;
    }),
    mode,
    names,
    started: Promise.all(blockers.map((other) => other.finished)).then(() => undefined)
  };
  let active = true;
  let pending = 0;
  running.add(transaction);

  // It commits when no request is pending once control returns to the event loop.
  const commitWhenIdle = () => {
    setTimeout(() => {
      if (active && pending === 0) {
        active = false;
        running.delete(transaction);
        commit();
      }
    }, 0);
  };

  const track = <T>(request: Promise<T>): Promise<T> => {
    pending += 1;
    const settle = () => {
      pending -= 1;

      if (pending === 0) {
        commitWhenIdle();
      }
    };
    void request.then(settle, settle);
    return request;
  };

  const place =
    <Args extends unknown[], Result>(request: (...args: Args) => Result, writes = false) =>
    (...args: Args): Result => {
      if (!active) {
        throw new DOMException("The transaction has finished.", "TransactionInactiveError");
      }

      if (writes && mode === "readonly") {
        throw new DOMException("The transaction is read-only.", "ReadOnlyError");
      }

      placingRequestIn = transaction;

      try {
        return request(...args);
      } finally {
        placingRequestIn = null;
      }
    };

  const objectStore = (name: string) => {
    if (!names.includes(name)) {
      throw new DOMException(`${name} is not part of this transaction`, "NotFoundError");
    }

    const api = createStoreApi(name, track);

    return {
      ...api,
      clear: place(api.clear, true),
      count: place(api.count),
      delete: place(api.delete, true),
      get: place(api.get),
      getAll: place(api.getAll),
      getAllKeys: place(api.getAllKeys),
      index: (indexName: string) => {
        const index = api.index(indexName);
        return { ...index, count: place(index.count), getAll: place(index.getAll) };
      },
      put: place(api.put, true)
    };
  };

  commitWhenIdle();

  return { done: transaction.finished, objectStore, store: objectStore(names[0] ?? "") };
};

const createDatabase = () => {
  // With isolation on, every shortcut (`db.get`, `db.put`...) is a transaction of its own.
  const storeApi = (name: string) =>
    isolatedTransactions
      ? createIsolatedTransaction([name], "readwrite").objectStore(name)
      : createStoreApi(name, untracked);

  return {
    close: () => undefined,
    count: (storeName: string) => storeApi(storeName).count(),
    countFromIndex: (storeName: string, indexName: string, key: unknown) =>
      storeApi(storeName).index(indexName).count(key),
    delete: (storeName: string, key: string) => storeApi(storeName).delete(key),
    get: (storeName: string, key: string) => storeApi(storeName).get(key),
    getAll: (storeName: string) => storeApi(storeName).getAll(),
    getAllFromIndex: (storeName: string, indexName: string, key?: unknown) =>
      storeApi(storeName).index(indexName).getAll(key),
    getAllKeys: (storeName: string) => storeApi(storeName).getAllKeys(),
    objectStoreNames: {
      contains: (name: string) => state.definitions.has(name)
    },
    put: (storeName: string, value: unknown) => storeApi(storeName).put(value),
    transaction: (storeNames: string | string[], mode: IDBTransactionMode = "readonly") => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];

      for (const name of names) {
        requireStore(name);
      }

      if (isolatedTransactions) {
        return createIsolatedTransaction(names, mode);
      }

      const first = names[0] ?? "";

      return {
        done: Promise.resolve(),
        objectStore: (name: string) => {
          if (!names.includes(name)) {
            throw new DOMException(`${name} is not part of this transaction`, "NotFoundError");
          }

          return storeApi(name);
        },
        store: storeApi(first)
      };
    }
  };
};

interface FakeOpenCallbacks {
  blocked?: (currentVersion: number, blockedVersion: number | null, event: unknown) => void;
  blocking?: (currentVersion: number, blockedVersion: number | null, event: unknown) => void;
  terminated?: () => void;
  upgrade?: (
    db: unknown,
    oldVersion: number,
    newVersion: number | null,
    transaction: unknown,
    event: unknown
  ) => void;
}

const snapshotRecords = () =>
  new Map(Array.from(state.records.entries(), ([name, records]) => [name, clone(records)]));

const snapshotDefinitions = () =>
  new Map(
    Array.from(state.definitions.entries(), ([name, definition]) => [
      name,
      { indexes: new Map(definition.indexes), keyPath: definition.keyPath }
    ])
  );

async function openDB(name: string, version?: number, callbacks: FakeOpenCallbacks = {}) {
  state.openCalls.push({ name, version });
  state.callbacks = callbacks;
  await Promise.resolve();

  if (state.openHold) {
    const hold = state.openHold;
    state.openHold = null;
    await hold;
  }

  if (state.failNextOpen) {
    const error = state.failNextOpen;
    state.failNextOpen = null;
    throw error;
  }

  if (state.blockedOnce) {
    state.blockedOnce = false;
    callbacks.blocked?.(state.oldVersion, version ?? null, {});
  }

  const targetVersion = version ?? Math.max(state.oldVersion, 1);

  if (state.oldVersion > targetVersion) {
    throw new DOMException(
      "The requested version is less than the existing version",
      "VersionError"
    );
  }

  if (state.oldVersion < targetVersion && callbacks.upgrade) {
    const recordsBefore = snapshotRecords();
    const definitionsBefore = snapshotDefinitions();
    const pending = new Set<Promise<unknown>>();
    let aborted = false;

    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise)
      );
      return promise;
    };

    const upgradeDb = {
      ...createDatabase(),
      createObjectStore: (storeName: string, options?: { keyPath?: string }) => {
        if (state.definitions.has(storeName)) {
          throw new DOMException(`Object store ${storeName} already exists`, "ConstraintError");
        }

        const definition: FakeStoreDefinition = {
          indexes: new Map(),
          keyPath: options?.keyPath ?? "id"
        };
        state.definitions.set(storeName, definition);
        state.records.set(storeName, new Map());
        fakeIdb.createdStores.push(storeName);

        return {
          createIndex: (indexName: string, keyPath: string) => {
            definition.indexes.set(indexName, keyPath);
          }
        };
      }
    };

    const upgradeTransaction = {
      abort: () => {
        aborted = true;
      },
      objectStore: (storeName: string) => createStoreApi(storeName, track)
    };

    callbacks.upgrade(upgradeDb, state.oldVersion, targetVersion, upgradeTransaction, {});

    // Let the versionchange transaction finish every request it queued, like IndexedDB does
    // before `success` fires.
    for (let round = 0; round < 1000; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (pending.size === 0) {
        break;
      }
    }

    if (aborted) {
      state.records = recordsBefore;
      state.definitions = definitionsBefore;
      throw new DOMException("The version change transaction was aborted.", "AbortError");
    }

    state.oldVersion = targetVersion;
  }

  return createDatabase();
}

/** Drop-in replacement for the `idb` module. */
export const fakeIdbModule = {
  deleteDB: () => Promise.resolve(),
  openDB
};

export const fakeIdb = {
  /** Store names created through `createObjectStore` since the last reset. */
  createdStores: [] as string[],

  get openCalls(): readonly FakeOpenCall[] {
    return state.openCalls;
  },

  get version(): number {
    return state.oldVersion;
  },

  /** Clears every store and definition. `version` is the database version already on disk. */
  reset(version = 0): void {
    state.definitions = new Map();
    state.records = new Map();
    state.oldVersion = version;
    state.openCalls = [];
    state.failNextOpen = null;
    state.openHold = null;
    state.blockedOnce = false;
    state.callbacks = null;
    state.failPuts = new Map();
    fakeIdb.createdStores = [];
    isolatedTransactions = null;
    placingRequestIn = null;
  },

  /** Declares a store as if an earlier schema version had created it. */
  defineStore(name: string, keyPath = "id", indexes: Record<string, string> = {}): void {
    state.definitions.set(name, { indexes: new Map(Object.entries(indexes)), keyPath });

    if (!state.records.has(name)) {
      state.records.set(name, new Map());
    }
  },

  hasStore(name: string): boolean {
    return state.definitions.has(name);
  },

  indexKeyPaths(name: string): Record<string, string> {
    return Object.fromEntries(state.definitions.get(name)?.indexes ?? []);
  },

  /** Writes records straight into a store (bypassing the app), e.g. legacy data. */
  seed(name: string, records: unknown[]): void {
    const { definition, records: store } = requireStore(name);

    for (const record of records) {
      store.set(String(readPath(record, definition.keyPath)), clone(record));
    }
  },

  records<T = unknown>(name: string): T[] {
    return Array.from(state.records.get(name)?.values() ?? []).map((value) => clone(value) as T);
  },

  record<T = unknown>(name: string, key: string): T | undefined {
    const value = state.records.get(name)?.get(key);
    return value === undefined ? undefined : (clone(value) as T);
  },

  failNextOpen(error: Error): void {
    state.failNextOpen = error;
  },

  /** The next open waits until the returned function is called (storage slow to answer). */
  holdNextOpen(): () => void {
    let release: () => void = () => undefined;
    state.openHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    return release;
  },

  blockNextOpen(): void {
    state.blockedOnce = true;
  },

  /** The next `put` into `storeName` (in any transaction) throws `error`. */
  failNextPut(storeName: string, error: Error): void {
    state.failPuts.set(storeName, error);
  },

  /** Simulates another tab asking for a newer version while this connection is open. */
  fireBlocking(newVersion = state.oldVersion + 1): void {
    state.callbacks?.blocking?.(state.oldVersion, newVersion, {});
  },

  /** Simulates the browser abnormally closing the connection. */
  fireTerminated(): void {
    state.callbacks?.terminated?.();
  },

  /**
   * Until the next reset, transactions are isolated like IndexedDB's (e.g. two tabs' writes):
   * one waits until every earlier overlapping transaction where either writes has committed; each
   * commits once no request is pending when control returns to the event loop (a request after
   * that throws TransactionInactiveError, a write in a readonly one ReadOnlyError); and every
   * shortcut (`db.get`, `db.put`...) is a transaction of its own. Commits wait for a `setTimeout`,
   * so it is opt-in (fake timers would hold them back). Failed requests do not abort or roll back.
   */
  isolateTransactions(): void {
    isolatedTransactions = new Set();
  }
};
