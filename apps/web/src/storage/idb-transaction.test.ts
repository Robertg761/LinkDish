import { beforeEach, describe, expect, it, vi } from "vitest";

import { runLinkDishTransaction } from "./idb-transaction";
import {
  COLLECTIONS_STORE_NAME,
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "./linkdish-db";
import { fakeIdb } from "./testing/fake-idb";

vi.mock("idb", async () => (await import("./testing/fake-idb")).fakeIdbModule);

const STORES = [COLLECTIONS_STORE_NAME, SAVED_RECIPES_STORE_NAME] as const;

describe("runLinkDishTransaction", () => {
  beforeEach(async () => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    await getLinkDishWebDb();
    fakeIdb.seed(COLLECTIONS_STORE_NAME, [{ id: "c1", name: "Soups" }]);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [{ id: "r1", title: "Pho" }]);
  });

  it("resolves with what the work returns once every store's writes are saved", async () => {
    let committed = false;

    const result = runLinkDishTransaction(STORES, "readwrite", async (tx) => {
      await Promise.all([
        tx.objectStore(COLLECTIONS_STORE_NAME).delete("c1"),
        tx.objectStore(SAVED_RECIPES_STORE_NAME).put({ id: "r1", title: "Pho ga" })
      ]);
      return "done";
    }).then((value) => {
      committed = true;
      return value;
    });

    expect(committed).toBe(false);
    await expect(result).resolves.toBe("done");
    expect(fakeIdb.records(COLLECTIONS_STORE_NAME)).toEqual([]);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, "r1")).toEqual({ id: "r1", title: "Pho ga" });
  });

  it("keeps nothing from any store when a write fails", async () => {
    fakeIdb.failNextPut(
      SAVED_RECIPES_STORE_NAME,
      new DOMException("The quota has been exceeded.", "QuotaExceededError")
    );

    await expect(
      runLinkDishTransaction(STORES, "readwrite", async (tx) => {
        // The collection's delete succeeds first; the recipe's put then fails.
        await tx.objectStore(COLLECTIONS_STORE_NAME).delete("c1");
        await tx.objectStore(SAVED_RECIPES_STORE_NAME).put({ id: "r2", title: "Ramen" });
      })
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(fakeIdb.records(COLLECTIONS_STORE_NAME)).toEqual([{ id: "c1", name: "Soups" }]);
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([{ id: "r1", title: "Pho" }]);
  });

  it("aborts, keeping nothing, when the work's own check throws after writing", async () => {
    await expect(
      runLinkDishTransaction(STORES, "readwrite", async (tx) => {
        await tx.objectStore(COLLECTIONS_STORE_NAME).delete("c1");
        throw new Error("changed my mind");
      })
    ).rejects.toThrow("changed my mind");

    expect(fakeIdb.records(COLLECTIONS_STORE_NAME)).toEqual([{ id: "c1", name: "Soups" }]);
  });

  it("lets the next transaction on those stores run after one aborts", async () => {
    fakeIdb.failNextPut(SAVED_RECIPES_STORE_NAME, new Error("disk full"));
    const failed = runLinkDishTransaction(STORES, "readwrite", (tx) =>
      tx.objectStore(SAVED_RECIPES_STORE_NAME).put({ id: "r2" })
    );
    const next = runLinkDishTransaction(STORES, "readwrite", (tx) =>
      tx.objectStore(SAVED_RECIPES_STORE_NAME).put({ id: "r3" })
    );

    await expect(failed).rejects.toThrow("disk full");
    await expect(next).resolves.toBe("r3");
    expect(fakeIdb.records(SAVED_RECIPES_STORE_NAME)).toEqual([
      { id: "r1", title: "Pho" },
      { id: "r3" }
    ]);
  });
});
