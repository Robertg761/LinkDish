import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORT_QUEUE_STORE_NAME, resetLinkDishWebDbForTests } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  claimNextQueuedImport,
  clearFinishedImports,
  enqueueImport,
  enqueueImports,
  getImportQueue,
  getNextQueuedImport,
  holdImportForSave,
  ImportQueueValidationError,
  markImportDone,
  markImportFailed,
  markImportProcessing,
  recoverStaleImports,
  removeImportQueueItem,
  renewImportClaim,
  resetImportQueueStoreForTests,
  retryImport,
  STALE_PROCESSING_MS,
  useImportQueue
} from "./import-queue-store";

import type { ImportQueuePendingSave } from "./import-queue-store";

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

  describe("pasted text with the link it came from", () => {
    const link = "https://example.com/noodles";
    const caption = `Sesame noodles, from ${link}\n200 g noodles\nToss and serve.`;

    it("keeps the link beside the text, without making it a link import", async () => {
      const item = await enqueueImport({ source: "in_app", sourceUrl: ` ${link} `, text: caption });

      expect(item).toMatchObject({ sourceUrl: link, status: "queued", text: caption });
      expect(item).not.toHaveProperty("url");
      expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).toMatchObject({ sourceUrl: link });
    });

    it("keeps the link through a claim, a failure, Retry and stale recovery", async () => {
      const item = await enqueueImport({ sourceUrl: link, text: caption });
      const start = Date.parse("2026-09-28T10:00:00.000Z");

      expect(await claimNextQueuedImport("tab-a", start)).toMatchObject({ sourceUrl: link });
      expect(await recoverStaleImports(start + STALE_PROCESSING_MS + 1)).toBe(1);
      await claimNextQueuedImport("tab-b");
      expect(await markImportFailed(item.id, "nope", "tab-b")).toMatchObject({ sourceUrl: link });
      expect(await retryImport(item.id)).toMatchObject({ sourceUrl: link, status: "queued" });
    });

    it("never takes a text's place for another text or for its link", async () => {
      const first = await enqueueImport({ sourceUrl: link, text: caption });
      const second = await enqueueImport({ sourceUrl: link, text: "Chili oil noodles\n..." });
      const again = await enqueueImport({ sourceUrl: link, text: caption });
      const page = await enqueueImport({ url: link });

      // Each paste is its own import (as it is online); the page itself is a link import.
      expect(new Set([first.id, second.id, again.id, page.id]).size).toBe(4);
      expect(page).not.toHaveProperty("sourceUrl");
      expect(page).not.toHaveProperty("text");
      // Adding the link again finds the link import, not a text that mentions it.
      expect((await enqueueImport({ url: link })).id).toBe(page.id);
      expect(fakeIdb.records(IMPORT_QUEUE_STORE_NAME)).toHaveLength(4);
    });

    it("queues the text without a link it couldn't import from", async () => {
      const item = await enqueueImport({ sourceUrl: "javascript:alert(1)", text: caption });

      expect(item).toMatchObject({ status: "queued", text: caption });
      expect(item).not.toHaveProperty("sourceUrl");
      // Only for text: a link alone is a link import, and a link import is its own source.
      await expect(enqueueImport({ sourceUrl: link })).rejects.toBeInstanceOf(
        ImportQueueValidationError
      );
      expect(
        await enqueueImport({ sourceUrl: "https://other.com/x", url: link })
      ).not.toHaveProperty("sourceUrl");
    });

    it("queues the text without a link the API wouldn't take (a sign-in in it, or too long)", async () => {
      for (const sourceUrl of [
        "https://cook:secret@example.com/noodles",
        "https://cook@example.com/noodles",
        `https://example.com/noodles?${"x".repeat(2_100)}`
      ]) {
        const item = await enqueueImport({ sourceUrl, text: caption });

        expect(item).toMatchObject({ status: "queued", text: caption });
        expect(item).not.toHaveProperty("sourceUrl");
      }

      // The longest link it takes is kept.
      const longest = `https://example.com/noodles?q=${"x".repeat(2_048 - 30)}`;
      expect(longest).toHaveLength(2_048);
      expect(await enqueueImport({ sourceUrl: longest, text: caption })).toMatchObject({
        sourceUrl: longest
      });
    });
  });

  it("queues a link once when two tabs add it at the same moment", async () => {
    // The share sheet in one tab and a paste in another (no navigator.locks to keep them apart).
    const [first, second] = await Promise.all([
      enqueueImport({ source: "share_sheet", url: "https://example.com/stew" }),
      enqueueImport({ url: "https://example.com/stew" })
    ]);

    expect(second.id).toBe(first.id);
    expect(fakeIdb.records(IMPORT_QUEUE_STORE_NAME)).toEqual([
      expect.objectContaining({ id: first.id, status: "queued", url: "https://example.com/stew" })
    ]);
  });

  it("re-queues a failed link once when two tabs add it again at the same moment", async () => {
    const first = await enqueueImport({ url: "https://example.com/stew" });
    await markImportFailed(first.id, "nope");

    const again = await Promise.all([
      enqueueImport({ url: "https://example.com/stew" }),
      enqueueImport({ url: "https://example.com/stew" })
    ]);

    expect(again.map((item) => [item.id, item.status])).toEqual([
      [first.id, "queued"],
      [first.id, "queued"]
    ]);
    expect(fakeIdb.records(IMPORT_QUEUE_STORE_NAME)).toHaveLength(1);
  });

  it("adds a batch of links in one go, each link once, alongside another tab's add", async () => {
    const waiting = await enqueueImport({ url: "https://example.com/soup" });

    const [batch, single] = await Promise.all([
      enqueueImports([
        { source: "in_app", url: "https://example.com/soup" },
        { source: "in_app", url: "https://example.com/stew" },
        { source: "in_app", url: "https://example.com/stew" },
        { source: "in_app", url: "https://example.com/pie" }
      ]),
      enqueueImport({ url: "https://example.com/pie" })
    ]);

    expect(batch.map((item) => item.url)).toEqual([
      "https://example.com/soup",
      "https://example.com/stew",
      "https://example.com/stew",
      "https://example.com/pie"
    ]);
    expect(batch[0]?.id).toBe(waiting.id);
    expect(batch[2]?.id).toBe(batch[1]?.id);
    expect(single.id).toBe(batch[3]?.id);
    expect(fakeIdb.records(IMPORT_QUEUE_STORE_NAME)).toHaveLength(3);
  });

  it("adds nothing from a batch with a link it can't import", async () => {
    await expect(
      enqueueImports([{ url: "https://example.com/soup" }, { url: "ftp://example.com/x" }])
    ).rejects.toBeInstanceOf(ImportQueueValidationError);
    expect(fakeIdb.records(IMPORT_QUEUE_STORE_NAME)).toEqual([]);
  });

  it("retries only a failed item, never one a tab has taken since", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    await markImportFailed(item.id, "nope");
    // Another tab's Retry put it back and that tab's worker claimed it; this tab still shows the
    // failure (and its Retry button) until the change reaches it.
    await retryImport(item.id);
    await claimNextQueuedImport("tab-b");

    expect(await retryImport(item.id)).toBeUndefined();
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).toMatchObject({
      claimedBy: "tab-b",
      status: "processing"
    });
    expect(await claimNextQueuedImport("tab-a")).toBeUndefined();
  });

  it("keeps an item a tab is importing right now instead of removing it", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    // This tab still shows it waiting (with Remove) when another tab's worker claims it.
    await claimNextQueuedImport("tab-b");

    expect(await removeImportQueueItem(item.id)).toBe(false);
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).toMatchObject({
      claimedBy: "tab-b",
      status: "processing"
    });

    await markImportFailed(item.id, "Nothing there.", "tab-b");
    expect(await removeImportQueueItem(item.id)).toBe(true);
    expect(await getImportQueue()).toEqual([]);
    // Already gone (another tab removed it): nothing left to keep.
    expect(await removeImportQueueItem(item.id)).toBe(true);
  });

  it("clears each finished import once when two tabs clear at the same moment", async () => {
    const soup = await enqueueImport({ url: "https://example.com/soup" });
    const stew = await enqueueImport({ url: "https://example.com/stew" });
    await enqueueImport({ url: "https://example.com/pie" });
    await markImportDone(soup.id, { recipeId: "recipe-1" });
    await markImportDone(stew.id, { recipeId: "recipe-2" });

    const [first, second] = await Promise.all([clearFinishedImports(), clearFinishedImports()]);

    expect(first + second).toBe(2);
    expect((await getImportQueue()).map((item) => item.url)).toEqual(["https://example.com/pie"]);
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

  it("claims each waiting item for one tab only, oldest first", async () => {
    const first = await enqueueImport({ url: "https://example.com/soup" });
    const second = await enqueueImport({ url: "https://example.com/stew" });

    // Two tabs asking at the same moment (no navigator.locks to keep them apart).
    const claims = await Promise.all([
      claimNextQueuedImport("tab-a"),
      claimNextQueuedImport("tab-b"),
      claimNextQueuedImport("tab-c")
    ]);

    expect(claims.map((item) => item?.id)).toEqual([first.id, second.id, undefined]);
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, first.id)).toMatchObject({
      attempts: 0,
      claimedBy: "tab-a",
      status: "processing"
    });
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, second.id)).toMatchObject({
      claimedBy: "tab-b",
      status: "processing"
    });
  });

  it("keeps a renewed claim, recovers a lapsed one, and ignores its old tab once another claims it", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    const start = Date.parse("2026-09-28T10:00:00.000Z");
    await claimNextQueuedImport("tab-a", start);

    // tab-a is still working: its renewals keep the item well past the first lease.
    await renewImportClaim(item.id, "tab-a", start + 4 * 60_000);
    expect(await recoverStaleImports(start + STALE_PROCESSING_MS + 60_000)).toBe(0);
    expect(await renewImportClaim(item.id, "tab-b", start + 5 * 60_000)).toBeUndefined();

    // tab-a went away: once its last renewal lapses, the item waits again for any tab.
    expect(await recoverStaleImports(start + 4 * 60_000 + STALE_PROCESSING_MS + 1)).toBe(1);
    const recovered = fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id);
    expect(recovered).toMatchObject({ claimedBy: "tab-a", status: "queued" });
    expect(recovered).not.toHaveProperty("claimedAt");

    // tab-b takes it; should tab-a wake up now, it no longer writes over the item.
    expect((await claimNextQueuedImport("tab-b"))?.id).toBe(item.id);
    expect(await markImportDone(item.id, { recipeId: "late" }, "tab-a")).toBeUndefined();
    expect(await renewImportClaim(item.id, "tab-a")).toBeUndefined();
    expect(await markImportFailed(item.id, "late", "tab-a")).toBeUndefined();
    expect(await markImportProcessing(item.id, "tab-b")).toMatchObject({
      attempts: 1,
      claimedBy: "tab-b",
      status: "processing"
    });
    expect(await markImportDone(item.id, { recipeId: "recipe-1" }, "tab-b")).toMatchObject({
      recipeId: "recipe-1",
      status: "done"
    });
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).not.toHaveProperty("claimedBy");
    expect(await renewImportClaim(item.id, "tab-b")).toBeUndefined();
  });

  it("lets a suspended tab take back and finish its lapsed item while no other tab has it", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    const start = Date.parse("2026-09-28T10:00:00.000Z");
    await claimNextQueuedImport("tab-a", start);
    expect(await recoverStaleImports(start + STALE_PROCESSING_MS + 1)).toBe(1);

    // tab-a resumes: its next renewal holds the item again, so no other tab can claim it.
    const resumed = start + STALE_PROCESSING_MS + 60_000;
    expect(await renewImportClaim(item.id, "tab-a", resumed)).toMatchObject({
      claimedAt: new Date(resumed).toISOString(),
      claimedBy: "tab-a",
      status: "processing"
    });
    expect(await claimNextQueuedImport("tab-b", resumed)).toBeUndefined();
    expect(await markImportDone(item.id, { recipeId: "recipe-1" }, "tab-a")).toMatchObject({
      recipeId: "recipe-1",
      status: "done"
    });

    // Or, before any renewal: its result is still recorded rather than imported again.
    const text = await enqueueImport({ text: "Soup: 1 onion." });
    await claimNextQueuedImport("tab-a", start);
    expect(await recoverStaleImports(start + STALE_PROCESSING_MS + 1)).toBe(1);
    expect(await markImportFailed(text.id, "Nothing there.", "tab-a")).toMatchObject({
      error: "Nothing there.",
      status: "failed"
    });
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, text.id)).not.toHaveProperty("claimedBy");
  });

  it("ignores a late renewal from a tab that already let its item go", async () => {
    const item = await enqueueImport({ url: "https://example.com/pie" });
    await claimNextQueuedImport("tab-a");

    // A pause or stop puts the item back; a renewal still in flight must not grab it again.
    expect(await retryImport(item.id, "tab-a")).toMatchObject({ status: "queued" });
    expect(await renewImportClaim(item.id, "tab-a")).toBeUndefined();
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).toMatchObject({ status: "queued" });
    expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).not.toHaveProperty("claimedBy");
  });

  describe("an item imported but not saved yet", () => {
    const pendingSave = {
      correlationId: "5d9a4b20-7e1f-4d5f-8fa2-838071ca35cb",
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      },
      recipe: {
        ingredients: [{ text: "1 onion" }],
        sourceUrl: "https://example.com/soup",
        steps: [{ index: 1, text: "Simmer." }],
        title: "Onion soup"
      },
      sourceUrl: "https://example.com/soup"
    } as unknown as ImportQueuePendingSave;

    it("waits with its recipe through stale recovery, a failed save and Retry until it's done", async () => {
      const item = await enqueueImport({ url: "https://example.com/soup" });
      const start = Date.parse("2026-09-28T10:00:00.000Z");
      await claimNextQueuedImport("tab-a", start);

      // Only the tab holding it puts it back with the recipe, letting go of it in the same write.
      expect(await holdImportForSave(item.id, pendingSave, "tab-b")).toBeUndefined();
      const held = await holdImportForSave(item.id, pendingSave, "tab-a");
      expect(held).toMatchObject({ pendingSave, status: "queued" });
      expect(held).not.toHaveProperty("claimedBy");

      // Claimed again, and recovered once that tab closed, it still has the recipe.
      expect(await claimNextQueuedImport("tab-b", start)).toMatchObject({ pendingSave });
      expect(await recoverStaleImports(start + STALE_PROCESSING_MS + 1)).toBe(1);
      expect(fakeIdb.record(IMPORT_QUEUE_STORE_NAME, item.id)).toMatchObject({
        pendingSave,
        status: "queued"
      });

      // A save that didn't work keeps it, for Retry or for adding the link again.
      await claimNextQueuedImport("tab-c");
      expect(await markImportFailed(item.id, "The disk is full.", "tab-c")).toMatchObject({
        pendingSave,
        status: "failed"
      });
      expect(await retryImport(item.id)).toMatchObject({ pendingSave, status: "queued" });
      await claimNextQueuedImport("tab-c");
      await markImportFailed(item.id, "The disk is full.", "tab-c");
      expect(await enqueueImport({ url: "https://example.com/soup" })).toMatchObject({
        id: item.id,
        pendingSave,
        status: "queued"
      });

      // Saved: the recipe is in the cookbook now, not on the item.
      await claimNextQueuedImport("tab-c");
      const done = await markImportDone(item.id, { recipeId: "recipe-1" }, "tab-c");
      expect(done).toMatchObject({ recipeId: "recipe-1", status: "done" });
      expect(done).not.toHaveProperty("pendingSave");
    });

    it("is claimed ahead of older links, which may need an import there's none left of", async () => {
      const older = await enqueueImport({ url: "https://example.com/stew" });
      const waiting = await enqueueImport({ url: "https://example.com/soup" });
      await holdImportForSave(waiting.id, pendingSave);

      expect((await claimNextQueuedImport("tab-a"))?.id).toBe(waiting.id);
      expect((await claimNextQueuedImport("tab-a"))?.id).toBe(older.id);
    });
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
      // The waiting one: an item being imported stays (see the test on removing one).
      await removeImportQueueItem(result.current.items[1]!.id);
    });
    expect(result.current.pendingCount).toBe(1);
  });
});
