import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "../../data/change-feed";
import {
  claimNextQueuedImport,
  enqueueImport,
  resetImportQueueStoreForTests,
  retryImport
} from "../../data/import-queue-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";

import { IMPORT_QUEUE_LOCK_NAME, useImportQueueRunner } from "./use-import-queue-runner";

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
});
