import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATA_CHANNEL_NAME,
  emitDataChange,
  resetDataChangeFeedForTests,
  setDataChannelFactoryForTests,
  subscribeDataChanges
} from "./change-feed";

const createFakeChannel = () => {
  const channel = {
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    receive(data: unknown) {
      channel.onmessage?.({ data } as MessageEvent);
    }
  };

  return channel;
};

describe("data change feed", () => {
  afterEach(() => {
    resetDataChangeFeedForTests();
  });

  it("hands same-tab listeners the written records and tells other tabs to reload", () => {
    const channel = createFakeChannel();
    const factory = vi.fn(() => channel);
    setDataChannelFactoryForTests(factory);
    const listener = vi.fn();
    subscribeDataChanges("collections", listener);
    const other = vi.fn();
    subscribeDataChanges("mealPlan", other);

    emitDataChange({ deletedIds: ["gone"], topic: "collections", upserted: [{ id: "a" }] });

    expect(factory).toHaveBeenCalledWith(DATA_CHANNEL_NAME);
    expect(listener).toHaveBeenCalledWith(
      { deletedIds: ["gone"], topic: "collections", upserted: [{ id: "a" }] },
      "local"
    );
    expect(other).not.toHaveBeenCalled();
    // Records never cross tabs; only the topic and the ids do (so other tabs re-read just them).
    expect(channel.postMessage).toHaveBeenCalledWith({
      deletedIds: ["gone"],
      topic: "collections",
      upsertedIds: ["a"],
      v: 1
    });
  });

  it("passes other tabs' written ids along, and leaves them out for big or id-less writes", () => {
    const channel = createFakeChannel();
    setDataChannelFactoryForTests(() => channel);
    const listener = vi.fn();
    subscribeDataChanges("savedRecipes", listener);

    channel.receive({ topic: "savedRecipes", upsertedIds: ["soup"], v: 1 });
    channel.receive({ topic: "savedRecipes", upsertedIds: [7], v: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { reload: true, topic: "savedRecipes", upsertedIds: ["soup"] },
      "remote"
    );

    emitDataChange({
      topic: "savedRecipes",
      upserted: Array.from({ length: 60 }, (_, index) => ({ id: `r${index}` }))
    });
    emitDataChange({ topic: "mealPlan", upserted: [{ date: "2026-09-28" }] });
    expect(channel.postMessage).toHaveBeenNthCalledWith(1, { topic: "savedRecipes", v: 1 });
    expect(channel.postMessage).toHaveBeenNthCalledWith(2, { topic: "mealPlan", v: 1 });
  });

  it("turns messages from other tabs into reload hints and ignores junk", () => {
    const channel = createFakeChannel();
    setDataChannelFactoryForTests(() => channel);
    const listener = vi.fn();
    subscribeDataChanges("savedRecipes", listener);

    channel.receive({ topic: "savedRecipes", v: 1 });
    channel.receive({ topic: "savedRecipes", v: 2 });
    channel.receive({ topic: "passwords", v: 1 });
    channel.receive("hello");
    channel.receive({ deletedIds: [1], topic: "savedRecipes", v: 1 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ reload: true, topic: "savedRecipes" }, "remote");
  });

  it("keeps working without BroadcastChannel and isolates listener failures", () => {
    setDataChannelFactoryForTests(() => null);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    subscribeDataChanges("importQueue", broken);
    const unsubscribe = subscribeDataChanges("importQueue", healthy);

    expect(() => emitDataChange({ topic: "importQueue" })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitDataChange({ topic: "importQueue" });
    expect(healthy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
