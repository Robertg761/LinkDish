import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COOK_SESSIONS_STORE_NAME,
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME,
  resetLinkDishWebDbForTests
} from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import {
  emitDataChange,
  resetDataChangeFeedForTests,
  setDataChannelFactoryForTests
} from "./change-feed";
import { whenImportQueueMayHaveItems, whenKitchenTimersMayExist } from "./stored-activity";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("stored activity", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    setDataChannelFactoryForTests(() => null);
  });

  it("stays quiet while the store is empty, and speaks up on the first write", async () => {
    const onActive = vi.fn();
    whenImportQueueMayHaveItems(onActive);

    await settle();
    expect(onActive).not.toHaveBeenCalled();

    emitDataChange({ topic: "importQueue", upserted: [{ id: "a" }] });
    emitDataChange({ topic: "importQueue", upserted: [{ id: "b" }] });
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("speaks up when the store already holds records", async () => {
    await getLinkDishWebDb();
    fakeIdb.seed(COOK_SESSIONS_STORE_NAME, [{ recipeId: "recipe-1", timers: [] }]);
    const onActive = vi.fn();
    whenKitchenTimersMayExist(onActive);

    await waitFor(() => expect(onActive).toHaveBeenCalledTimes(1));
    // Another store's writes don't count.
    emitDataChange({ topic: "importQueue", upserted: [{ id: "a" }] });
    expect(onActive).toHaveBeenCalledTimes(1);
  });

  it("ignores everything once stopped", async () => {
    await getLinkDishWebDb();
    fakeIdb.seed(IMPORT_QUEUE_STORE_NAME, [{ id: "queued" }]);
    const onActive = vi.fn();
    const stop = whenImportQueueMayHaveItems(onActive);
    stop();

    await settle();
    emitDataChange({ topic: "importQueue", upserted: [{ id: "b" }] });
    expect(onActive).not.toHaveBeenCalled();
  });
});
