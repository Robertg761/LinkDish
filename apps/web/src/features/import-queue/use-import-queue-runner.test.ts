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

const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  user: null as { billingPlan: "free" | "plus"; email: string; id: string } | null
}));

// Requests carry whoever is signed in: their credentials change with the account.
vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    credentialsKey: authState.isAuthenticated ? `clerk:${authState.user?.id ?? ""}` : "session:",
    credentialsReady: true,
    isAuthenticated: authState.isAuthenticated,
    user: authState.user
  })
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
    authState.isAuthenticated = true;
    authState.user = null;
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

  it("hands the queue to an account that signs in mid-run, without the last one's pause", async () => {
    authState.isAuthenticated = false;
    let firstRun: { isCurrent?: () => boolean } | undefined;
    let finishRun: (result: { paused: string | null; processed: number }) => void = () => undefined;
    runnerMocks.runImportQueue.mockImplementationOnce(
      (context: { isCurrent?: () => boolean }) =>
        new Promise((resolve) => {
          firstRun = context;
          finishRun = resolve;
        })
    );

    const { rerender } = renderHook(() => useImportQueueRunner());
    await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledOnce());
    expect(firstRun?.isCurrent?.()).toBe(true);

    authState.isAuthenticated = true;
    authState.user = { billingPlan: "plus", email: "a@example.com", id: "user_a" };
    rerender();
    expect(firstRun?.isCurrent?.()).toBe(false);

    // The signed-out allowance ran out: that's no reason to pause the account now signed in.
    await act(async () => {
      finishRun({ paused: "import_limit", processed: 0 });
      await Promise.resolve();
    });

    await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2));
    expect(runnerMocks.runImportQueue.mock.calls[1]?.[0]).toMatchObject({
      isAuthenticated: true,
      tier: "plus"
    });
  });

  it("lifts one account's plan-limit pause when another account signs in", async () => {
    authState.user = { billingPlan: "plus", email: "a@example.com", id: "user_a" };
    runnerMocks.runImportQueue.mockResolvedValueOnce({ paused: "import_limit", processed: 0 });

    const { rerender, result } = renderHook(() => useImportQueueRunner());
    await waitFor(() => expect(result.current.paused).toBe("import_limit"));

    authState.user = { billingPlan: "plus", email: "b@example.com", id: "user_b" };
    rerender();

    expect(result.current.paused).toBeNull();
    await waitFor(() => expect(runnerMocks.runImportQueue).toHaveBeenCalledTimes(2));
  });

  it("tells the importer's allowance to refresh once the queue has imported something", async () => {
    const { getImportUsageGeneration } = await import("../extract/import-usage-signal");
    const before = getImportUsageGeneration();
    runnerMocks.runImportQueue.mockResolvedValue({ paused: null, processed: 1 });

    renderHook(() => useImportQueueRunner());

    await waitFor(() => expect(getImportUsageGeneration()).toBe(before + 1));
  });

  describe("when someone else signs in (or out) while the queue runs", () => {
    type RunContext = { isAuthenticated: boolean; isCurrent: () => boolean };
    type RunResult = { paused: string | null; processed: number };

    /** The first run waits until `finish` (as a long import would); later runs find nothing. */
    const holdFirstRun = () => {
      const runs: RunContext[] = [];
      let finish: (result: RunResult) => void = () => undefined;
      runnerMocks.runImportQueue.mockImplementation((context: RunContext) => {
        runs.push(context);
        return runs.length === 1
          ? new Promise<RunResult>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ paused: null, processed: 0 });
      });
      return { finish: (result: RunResult) => finish(result), runs };
    };

    it("stops the run for the last account and works through the queue for the next", async () => {
      const { finish, runs } = holdFirstRun();
      const { rerender } = renderHook(() => useImportQueueRunner());
      await waitFor(() => expect(runs).toHaveLength(1));
      expect(runs[0]?.isCurrent()).toBe(true);

      // Another account signs straight in (a cached user replaced once Clerk answers).
      authState.user = { billingPlan: "free", email: "b@example.com", id: "user_2" };
      rerender();

      // The run for the last account learns it should stop, and stops with the queue as it was.
      expect(runs[0]?.isCurrent()).toBe(false);
      await act(async () => {
        finish({ paused: null, processed: 0 });
        await Promise.resolve();
      });

      await waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[1]?.isCurrent()).toBe(true);
    });

    it("works through the queue signed out once the account signs out mid-run", async () => {
      const { finish, runs } = holdFirstRun();
      const { rerender } = renderHook(() => useImportQueueRunner());
      await waitFor(() => expect(runs).toHaveLength(1));

      authState.isAuthenticated = false;
      rerender();

      expect(runs[0]?.isCurrent()).toBe(false);
      await act(async () => {
        finish({ paused: null, processed: 0 });
        await Promise.resolve();
      });

      await waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[1]).toMatchObject({ isAuthenticated: false });
    });

    it("doesn't hold the next account to the last account's limit", async () => {
      const { finish, runs } = holdFirstRun();
      const { rerender, result } = renderHook(() => useImportQueueRunner());
      await waitFor(() => expect(runs).toHaveLength(1));

      authState.user = { billingPlan: "free", email: "b@example.com", id: "user_2" };
      rerender();
      await act(async () => {
        finish({ paused: "import_limit", processed: 0 });
        await Promise.resolve();
      });

      await waitFor(() => expect(runs).toHaveLength(2));
      await waitFor(() => expect(result.current.running).toBe(false));
      expect(result.current.paused).toBeNull();
    });
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
