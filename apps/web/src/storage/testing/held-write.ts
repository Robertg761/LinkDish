/**
 * A write that is still pending while other changes land, and then fails (test-only, never
 * imported by app code). Works on a connection the fake `idb` hands out, whose methods are plain,
 * replaceable props.
 */

export interface HeldWrite {
  /** Fails the held write (every request it made, and its transaction's `done`) with `error`. */
  fail: (error: Error) => void;
  /** Resolves once the app has made the held call. */
  started: Promise<void>;
}

type HeldMethod = "delete" | "put" | "transaction";

/**
 * Replaces the connection's next `method` call: a `delete` or `put` shortcut, or a transaction
 * (and every request made in it), that writes nothing and waits until {@link HeldWrite.fail}.
 * Later calls go to the real connection again.
 */
export function holdNextWrite(connection: object, method: HeldMethod): HeldWrite {
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // A transaction's `done` may have no one waiting on it once its first request failed.
  failed.catch(() => undefined);

  let start: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  const request = () => failed;
  const store = {
    clear: request,
    count: request,
    delete: request,
    get: request,
    getAll: request,
    getAllKeys: request,
    put: request
  };
  const transaction = {
    abort: () => undefined,
    done: failed,
    objectStore: () => store,
    store
  };
  const methods = connection as Record<string, unknown>;
  const original = methods[method];

  methods[method] = () => {
    methods[method] = original;
    start();
    return method === "transaction" ? transaction : failed;
  };

  return { fail: (error) => fail(error), started };
}

export interface QueuedTransaction {
  /** Lets the queued transaction finish. */
  release: () => void;
  /** Resolves once the app has opened the queued transaction. */
  started: Promise<void>;
}

/**
 * The connection's next transaction runs its requests, but its `done` only settles once
 * {@link QueuedTransaction.release} is called: like a read IndexedDB queues behind an earlier
 * readwrite transaction on the same store, whose result comes back after that write settles.
 * Later transactions go to the real connection again.
 */
export function queueNextTransaction(connection: object): QueuedTransaction {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let start: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  const methods = connection as Record<string, unknown>;
  const original = methods.transaction as (...args: unknown[]) => { done: Promise<void> };

  methods.transaction = (...args: unknown[]) => {
    methods.transaction = original;
    const transaction = original.apply(connection, args);
    const done = transaction.done.then(() => released);
    done.catch(() => undefined);
    start();
    return { ...transaction, done };
  };

  return { release: () => release(), started };
}
