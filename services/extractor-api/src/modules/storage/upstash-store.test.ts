import { describe, expect, it } from "vitest";

import {
  addStoreSetMembers,
  countStoreKeys,
  deleteStoreKeys,
  setStoreString
} from "./upstash-store.js";

describe("countStoreKeys", () => {
  it("counts memory keys matching a glob pattern", async () => {
    await setStoreString("linkdish-test:user:v1:alpha", "a");
    await setStoreString("linkdish-test:user:v1:beta", "b");
    await setStoreString("linkdish-test:session:v1:gamma", "c");
    await addStoreSetMembers("linkdish-test:user-sessions:v1:alpha", "s1");

    expect(await countStoreKeys("linkdish-test:user:v1:*")).toBe(2);
    expect(await countStoreKeys("linkdish-test:missing:*")).toBe(0);

    await deleteStoreKeys("linkdish-test:user:v1:alpha");

    expect(await countStoreKeys("linkdish-test:user:v1:*")).toBe(1);
  });

  it("does not treat glob pattern characters as regex", async () => {
    await setStoreString("linkdish-test:dot.key:v1:one", "a");

    expect(await countStoreKeys("linkdish-test:dotXkey:*")).toBe(0);
    expect(await countStoreKeys("linkdish-test:dot.key:*")).toBe(1);
  });
});
