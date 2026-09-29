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
