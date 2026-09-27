import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_QUEUE_STORE_NAME, resetLinkDishWebDbForTests } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  clearFinishedImports,
  enqueueImport,
  getImportQueue,
  getNextQueuedImport,
  ImportQueueValidationError,
  markImportDone,
  markImportFailed,
  markImportProcessing,
  recoverStaleImports,
  removeImportQueueItem,
  resetImportQueueStoreForTests,
  retryImport,
  STALE_PROCESSING_MS,
  useImportQueue
} from "./import-queue-store";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

describe("import-queue-store", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetImportQueueStoreForTests();
    setDataChannelFactoryForTests(() => null);
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates input", async () => {
    await expect(enqueueImport({})).rejects.toBeInstanceOf(ImportQueueValidationError);
    await expect(enqueueImport({ url: "ftp://example.com/x" })).rejects.toThrow("http");
    await expect(enqueueImport({ url: "not a link" })).rejects.toThrow("recipe link");
  });

  it("runs an item through its lifecycle", async () => {
    const item = await enqueueImport({ url: " https://example.com/soup " });
    expect(item).toMatchObject({ attempts: 0, status: "queued", url: "https://example.com/soup" });
    expect((await getNextQueuedImport())?.id).toBe(item.id);

    expect(await markImportProcessing(item.id)).toMatchObject({
      attempts: 1,
      status: "processing"
    });
    expect(await markImportFailed(item.id, "  offline  ")).toMatchObject({
      error: "offline",
      status: "failed"
    });
    expect(await getNextQueuedImport()).toBeUndefined();

    const retried = await retryImport(item.id);
    expect(retried?.status).toBe("queued");
    expect(retried).not.toHaveProperty("error");

    expect(await markImportDone(item.id, { recipeId: "recipe-9" })).toMatchObject({
      recipeId: "recipe-9",
      status: "done"
    });
    expect(await clearFinishedImports()).toBe(1);
    expect(await getImportQueue()).toEqual([]);
  });

  it("does not queue the same waiting link twice and re-queues a failed one", async () => {
    const first = await enqueueImport({ url: "https://example.com/stew" });
    const again = await enqueueImport({ url: "https://example.com/stew" });
    expect(again.id).toBe(first.id);

    await markImportFailed(first.id, "nope");
    const requeued = await enqueueImport({ url: "https://example.com/stew" });
    expect(requeued).toMatchObject({ id: first.id, status: "queued" });

    const text = await enqueueImport({ text: "2 eggs\nwhisk" });
    expect(text.id).not.toBe(first.id);
    expect(await getImportQueue()).toHaveLength(2);
  });

  it("puts stale processing items back in the queue", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    await markImportProcessing(item.id);
    const processing = fakeIdb.record<{ updatedAt: string }>(IMPORT_QUEUE_STORE_NAME, item.id)!;

    expect(await recoverStaleImports(Date.parse(processing.updatedAt) + 1000)).toBe(0);
    expect(
      await recoverStaleImports(Date.parse(processing.updatedAt) + STALE_PROCESSING_MS + 1)
    ).toBe(1);
    expect((await getNextQueuedImport())?.id).toBe(item.id);
  });

  it("counts pending and failed items in the hook", async () => {
    const { result } = renderHook(() => useImportQueue());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      const a = await enqueueImport({ url: "https://example.com/a" });
      await enqueueImport({ url: "https://example.com/b" });
      const c = await enqueueImport({ url: "https://example.com/c" });
      await markImportProcessing(a.id);
      await markImportFailed(c.id, "blocked");
    });

    expect(result.current.items.map((item) => item.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c"
    ]);
    expect(result.current.pendingCount).toBe(2);
    expect(result.current.failedCount).toBe(1);

    await act(async () => {
      await removeImportQueueItem(result.current.items[0]!.id);
    });
    expect(result.current.pendingCount).toBe(1);
  });
});
