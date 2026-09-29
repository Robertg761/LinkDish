import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  claimNextQueuedImport,
  enqueueImport,
  getImportQueue,
  markImportDone,
  resetImportQueueStoreForTests,
  retryImport
} from "../../data/import-queue-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import {
  IMPORT_QUEUE_LOCK_NAME,
  STORAGE_RETRY_MS,
  useImportQueueRunner
} from "./use-import-queue-runner";

vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({ credentialsReady: true, isAuthenticated: true, user: null })
}));

const runnerMocks = vi.hoisted(() => ({
  heldLocks: [] as string[],
  runImportQueue: vi.fn()
}));

vi.mock("./import-queue-runner", () => ({ runImportQueue: runnerMocks.runImportQueue }));

type LockCallback = (lock: { name: string } | null) => Promise<void>;

/**
 * A run as the real runner does it when the cookbook can't be read (as `owner`): claim the next
 * link, read (a few ms), let the link go and stop. Afterwards, while `failures` lasts only, runs
 * import the link.
 */
const storageTrouble = (options: { failures?: number; owner?: () => string } = {}) => {
  let failures = options.failures ?? Infinity;
  const owner = options.owner ?? (() => "this-tab");

  return async () => {
    const tab = owner();
    const item = await claimNextQueuedImport(tab);

    if (!item) {
      return { paused: null, processed: 0 };
    }

    if (failures <= 0) {
      await markImportDone(item.id, {}, tab);
      return { paused: null, processed: 1 };
    }

    failures -= 1;
    await new Promise((resolve) => setTimeout(resolve, 3));
    await retryImport(item.id, tab);
    throw new DOMException("The disk is unreadable.", "UnknownError");
  };
};

const setLocks = (locks: unknown) => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
};

describe("useImportQueueRunner", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetImportQueueStoreForTests();
    setDataChannelFactoryForTests(() => null);
    // A new link is a new item (the test setup otherwise gives every item the same id).
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    runnerMocks.heldLocks = [];
    runnerMocks.runImportQueue.mockReset();
    // The queue as the runner left it: nothing more to do until it changes.
    runnerMocks.runImportQueue.mockImplementation(() => {
      return Promise.resolve({ heldLocks: [...runnerMocks.heldLocks], paused: null, processed: 0 });
    });
    await enqueueImport({ url: "https://example.com/soup" });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "locks");
    vi.restoreAllMocks();
  });

  it("works through the queue while holding the queue lock", async () => {
    const request = vi.fn(async (name: string, _options: unknown, callback: LockCallback) => {
      runnerMocks.heldLocks.push(name);

      try {
        await callback({ name });
      } finally {
        runnerMocks.heldLocks.pop();
      }
    });
    setLocks({ request });

    renderHook(() => useImportQueueRunner());

    await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      IMPORT_QUEUE_LOCK_NAME,
      { ifAvailable: true },
      expect.any(Function)
    );
    await expect(runnerMocks.runImportQueue.mock.results[0]?.value).resolves.toMatchObject({
      heldLocks: [IMPORT_QUEUE_LOCK_NAME]
    });
  });

  it("tells the importer's allowance to refresh once the queue has imported something", async () => {
    const { getImportUsageGeneration } = await import("../extract/import-usage-signal");
    const before = getImportUsageGeneration();
    runnerMocks.runImportQueue.mockResolvedValue({ paused: null, processed: 1 });

    renderHook(() => useImportQueueRunner());

    await waitFor(() => expect(getImportUsageGeneration()).toBe(before + 1));
  });

  it("leaves the queue to the tab that already holds the lock", async () => {
    const request = vi.fn((_name: string, _options: unknown, callback: LockCallback) =>
      callback(null)
    );
    setLocks({ request });

    const { result } = renderHook(() => useImportQueueRunner());

    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(runnerMocks.runImportQueue).not.toHaveBeenCalled();
  });

  it("runs the queue itself without Web Locks (claims keep tabs from sharing an item)", async () => {
    expect("locks" in navigator).toBe(false);

    renderHook(() => useImportQueueRunner());

    await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce());
  });

  it("waits for the queue to change after storage trouble, not for the item it let go", async () => {
    runnerMocks.runImportQueue.mockImplementation(async () => {
      // As the runner does when the cookbook can't be read: claim, let the item go, stop.
      const item = await claimNextQueuedImport("this-tab");

      if (item) {
        await retryImport(item.id, "this-tab");
      }

      throw new DOMException("The disk is unreadable.", "UnknownError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { result } = renderHook(() => useImportQueueRunner());

      await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.running).toBe(false));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();

      // Something new to import: worth another try.
      await act(async () => {
        await enqueueImport({ url: "https://example.com/stew" });
      });
      await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2));
    } finally {
      warn.mockRestore();
    }
  });

  it("two tabs with storage trouble each stop, instead of restarting each other", async () => {
    let runs = 0;
    // Each run as its own tab: one tab letting the link go is a change the other tab sees.
    runnerMocks.runImportQueue.mockImplementation(storageTrouble({ owner: () => `tab-${++runs}` }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const first = renderHook(() => useImportQueueRunner());
      await waitFor(() => expect(warn).toHaveBeenCalledOnce());
      await waitFor(() => expect(first.result.current.running).toBe(false));
      const second = renderHook(() => useImportQueueRunner());
      await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
      await act(() => new Promise((resolve) => setTimeout(resolve, 300)));

      // Once each: the same link let go of again is not something new to try.
      expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2);
      expect(first.result.current).toMatchObject({ running: false, stalled: true });
      expect(second.result.current).toMatchObject({ running: false, stalled: true });
      expect((await getImportQueue()).map((item) => item.status)).toEqual(["queued"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("tries again by itself after storage trouble, waiting longer each time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    runnerMocks.runImportQueue.mockImplementation(storageTrouble({ failures: 2 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const waitMs = async (ms: number) => {
      await act(() => vi.advanceTimersByTimeAsync(ms));
    };

    try {
      const { result } = renderHook(() => useImportQueueRunner());

      await waitFor(() => expect(warn).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.running).toBe(false));
      expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce();
      await waitMs(STORAGE_RETRY_MS - 1000);
      expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce();
      await waitMs(1000);
      await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.running).toBe(false));
      expect(result.current.stalled).toBe(true);

      // Twice as long before the next try.
      await waitMs(STORAGE_RETRY_MS);
      expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2);
      await waitMs(STORAGE_RETRY_MS);
      await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(result.current.stalled).toBe(false));
      expect((await getImportQueue()).map((item) => item.status)).toEqual(["done"]);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("tries again at once on resume after storage trouble", async () => {
    runnerMocks.runImportQueue.mockImplementation(storageTrouble({ failures: 1 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { result } = renderHook(() => useImportQueueRunner());

      await waitFor(() => expect(warn).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.running).toBe(false));
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce();
      expect(result.current.stalled).toBe(true);

      act(() => result.current.resume());
      await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(result.current.stalled).toBe(false));
      expect((await getImportQueue()).map((item) => item.status)).toEqual(["done"]);
    } finally {
      warn.mockRestore();
    }
  });
});
