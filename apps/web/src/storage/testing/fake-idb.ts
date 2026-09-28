/**
 * A small Map-backed stand-in for the parts of `idb` LinkDish uses. Test-only (never imported by
 * app code). Use it from a test with:
 *
 *   vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);
 *
 * It models object stores with key paths and indexes, multi-store transactions with `done`
 * (readwrite ones over the same stores run one at a time, so a read-then-write in one is atomic
 * across "tabs" sharing the fake), the upgrade callback (including its versionchange transaction), and `abort()` rolling the whole
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
  /** Runs once, after the next `getAll` on a store has read it and before it answers. */
  afterGetAll: Map<string, () => Promise<void> | void>;
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
  /** Readwrite transactions not yet committed, oldest first. */
  writers: Array<{ done: Promise<void>; stores: readonly string[] }>;
}

const state: FakeIdbState = {
  afterGetAll: new Map(),
  blockedOnce: false,
  callbacks: null,
  failPuts: new Map(),
  definitions: new Map(),
  failNextOpen: null,
  openHold: null,
  oldVersion: 0,
  openCalls: [],
  records: new Map(),
  writers: []
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
  await Promise.resolve();
  return run();
};

/** A request's optional follow-up, run before it answers (and, in a transaction, while it is still pending). */
type AfterRequest<T> = (value: T) => Promise<T>;

type RunRequest = <T>(run: () => T, after?: AfterRequest<T>) => Promise<T>;

const withAfter = <T>(promise: Promise<T>, after?: AfterRequest<T>): Promise<T> =>
  after ? promise.then(after) : promise;

/** The hook `fakeIdb.afterNextGetAll` set for `name`, if any; it runs once. */
const afterGetAllOn =
  (name: string): AfterRequest<unknown[]> =>
  async (records) => {
    const afterGetAll = state.afterGetAll.get(name);

    if (afterGetAll) {
      state.afterGetAll.delete(name);
      await afterGetAll();
    }

    return records;
  };

const createStoreApi = (name: string, request: RunRequest) => {
  const indexApi = (indexName: string) => ({
    count: (key: unknown) =>
      request(() => {
        const { definition, records } = requireStore(name);
        const keyPath = definition.indexes.get(indexName);

        if (!keyPath) {
          throw new DOMException(`No index named ${indexName}`, "NotFoundError");
        }

        return Array.from(records.values()).filter((record) => readPath(record, keyPath) === key)
          .length;
      }),
    getAll: (key?: unknown) =>
      request(() => {
        const { definition, records } = requireStore(name);
        const keyPath = definition.indexes.get(indexName) ?? indexName;

        return Array.from(records.values())
          .filter((record) => key === undefined || readPath(record, keyPath) === key)
          .map(clone);
      })
  });

  return {
    clear: () => request(() => requireStore(name).records.clear()),
    count: () => request(() => requireStore(name).records.size),
    delete: (key: string) =>
      request(() => {
        requireStore(name).records.delete(String(key));
      }),
    get: (key: string) => request(() => clone(requireStore(name).records.get(String(key)))),
    getAll: () =>
      request(
        () => Array.from(requireStore(name).records.values()).map(clone),
        afterGetAllOn(name)
      ),
    getAllKeys: () => request(() => Array.from(requireStore(name).records.keys())),
    index: indexApi,
    put: (value: unknown) =>
      request(() => {
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
  };
};

/**
 * Microtask turns an idle transaction waits for its caller's next request before it commits.
 * IndexedDB commits once no request is pending and the page returns to the event loop; the fake
 * uses no timers (tests with fake timers still work), so it gives the caller this many turns to
 * `await` a result and issue the next request.
 */
const COMMIT_TURNS = 20;

/**
 * An explicit transaction. Readwrite transactions whose stores overlap run one at a time, in the
 * order they were created (as in IndexedDB), so a read-then-write inside one is atomic. Requests
 * made after it committed fail with `TransactionInactiveError`. `done` resolves on commit.
 */
const createTransaction = (names: string[], mode: string | undefined) => {
  const readwrite = mode === "readwrite";
  const earlier = readwrite
    ? state.writers.filter((writer) => writer.stores.some((name) => names.includes(name)))
    : [];
  const ready = Promise.all(earlier.map((writer) => writer.done)).then(() => undefined);
  let commit: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const writer = { done, stores: names };
  let pending = 0;
  let activity = 0;
  let finished = false;

  if (readwrite) {
    state.writers.push(writer);
  }

  const commitWhenIdle = async () => {
    const seen = activity;

    for (let turn = 0; turn < COMMIT_TURNS; turn += 1) {
      await Promise.resolve();
    }

    if (!finished && pending === 0 && activity === seen) {
      finished = true;
      state.writers = state.writers.filter((entry) => entry !== writer);
      commit();
    }
  };

  const settle = () => {
    pending -= 1;
    activity += 1;
    void commitWhenIdle();
  };

  const request = <T>(run: () => T, after?: AfterRequest<T>): Promise<T> => {
    if (finished) {
      return Promise.reject(
        new DOMException("The transaction has finished.", "TransactionInactiveError")
      );
    }

    pending += 1;
    activity += 1;
    const result = ready.then(() => withAfter(tick(run), after));
    void result.then(settle, settle);
    return result;
  };

  void ready.then(commitWhenIdle);
  const storeApi = (name: string) => createStoreApi(name, request);

  return {
    done,
    objectStore: (name: string) => {
      if (!names.includes(name)) {
        throw new DOMException(`${name} is not part of this transaction`, "NotFoundError");
      }

      return storeApi(name);
    },
    store: storeApi(names[0] ?? "")
  };
};

const createDatabase = () => {
  const storeApi = (name: string) =>
    createStoreApi(name, <T>(run: () => T, after?: AfterRequest<T>) => withAfter(tick(run), after));

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
    transaction: (storeNames: string | string[], mode?: string) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];

      for (const name of names) {
        requireStore(name);
      }

      return createTransaction(names, mode);
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
      objectStore: (storeName: string) =>
        createStoreApi(storeName, <T>(run: () => T, after?: AfterRequest<T>) =>
          track(withAfter(tick(run), after))
        )
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
    state.writers = [];
    state.afterGetAll = new Map();
    fakeIdb.createdStores = [];
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

  /**
   * The next `getAll` on `storeName` (in any transaction) runs `callback`, and waits for it,
   * after reading the store and before answering: another write landing between a read and the
   * writes based on it.
   */
  afterNextGetAll(storeName: string, callback: () => Promise<void> | void): void {
    state.afterGetAll.set(storeName, callback);
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
  }
};
