import { describe, expect, it } from "vitest";

import {
  fingerprintKey,
  fingerprintPayload,
  LIBRARY_RECIPE_SYNC_GROUPS,
  LibrarySyncCancelledError,
  librarySyncKey,
  mergeLibraryPayloads,
  resolveRemoteChange,
  runLibrarySync,
  stableStringify,
  utf8ByteLength
} from "./library-sync.js";

import type {
  LibraryItemKind,
  LibraryLocalWrite,
  LibraryPushResult,
  LibrarySyncAdapter,
  LibrarySyncBase,
  LibrarySyncChange,
  LibrarySyncPayload
} from "./library-sync.js";

const recipe = (overrides: LibrarySyncPayload = {}): LibrarySyncPayload => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  fetchMode: "http",
  provenance: ["jsonld"],
  recipe: { title: "Soup" },
  strategy: "recipe-schema",
  warnings: [],
  ...overrides
});

const fingerprint = (payload: LibrarySyncPayload) =>
  fingerprintPayload(payload, LIBRARY_RECIPE_SYNC_GROUPS);

/* ------------------------------------------------------------------------------------------------
 * A fake cloud (like the API: the newest copy wins, unless it was merged with an older one) and
 * fake devices
 * ---------------------------------------------------------------------------------------------- */

class FakeCloud {
  public rev = 0;
  public items = new Map<string, { change: LibrarySyncChange; rev: number }>();
  public refuse: (change: LibrarySyncChange) => boolean = () => false;
  public pushes = 0;

  public pull(since: string, pageSize = 100) {
    const after = Number(since);
    const reset = after > this.rev;
    const from = reset ? 0 : after;
    const page = [...this.items.values()]
      .filter((entry) => entry.rev > from)
      .sort((left, right) => left.rev - right.rev)
      .slice(0, pageSize);
    const last = page.at(-1)?.rev ?? (reset ? this.rev : after);

    return {
      changes: page.map((entry) => structuredClone(entry.change)),
      cursor: String(last),
      hasMore: [...this.items.values()].some((entry) => entry.rev > last),
      ...(reset ? { reset: true } : {})
    };
  }

  public push(changes: readonly LibrarySyncChange[]): LibraryPushResult {
    this.pushes += 1;
    const result: LibraryPushResult = { accepted: [], newer: [], rejected: [] };

    changes.forEach((change, index) => {
      if (this.refuse(change)) {
        result.rejected.push({ index, reason: "invalid" });
        return;
      }

      const { baseUpdatedAt, ...item } = change;
      const key = librarySyncKey(item.kind, item.id);
      const stored = this.items.get(key);

      if (
        stored &&
        (stored.change.updatedAt > item.updatedAt ||
          (baseUpdatedAt !== undefined && baseUpdatedAt !== stored.change.updatedAt))
      ) {
        result.newer.push(structuredClone(stored.change));
        return;
      }

      this.rev += 1;
      this.items.set(key, { change: structuredClone(item), rev: this.rev });
      result.accepted.push({ id: change.id, kind: change.kind });
    });

    return result;
  }
}

class FakeDevice implements LibrarySyncAdapter {
  public items = new Map<
    string,
    { kind: LibraryItemKind; id: string; payload: LibrarySyncPayload }
  >();
  public cursor = "0";
  public bases = new Map<string, LibrarySyncBase>();
  public current = true;
  /** Runs before each applyLocal, to simulate an edit landing while a sync is out. */
  public beforeApply: (() => void) | null = null;

  public constructor(
    private readonly cloud: FakeCloud,
    private readonly pageSize = 100
  ) {}

  public put(id: string, payload: LibrarySyncPayload, kind: LibraryItemKind = "recipe") {
    this.items.set(librarySyncKey(kind, id), { id, kind, payload });
  }

  public get(id: string, kind: LibraryItemKind = "recipe") {
    return this.items.get(librarySyncKey(kind, id))?.payload;
  }

  public remove(id: string, kind: LibraryItemKind = "recipe") {
    this.items.delete(librarySyncKey(kind, id));
  }

  public readLocal() {
    return Promise.resolve(new Map(structuredClone([...this.items])));
  }

  public readState() {
    return Promise.resolve({ bases: new Map(this.bases), cursor: this.cursor });
  }

  public applyLocal(writes: readonly LibraryLocalWrite[]) {
    this.beforeApply?.();
    const written = new Set<string>();

    for (const write of writes) {
      const key = librarySyncKey(write.kind, write.id);
      const stored = this.items.get(key);
      const storedKey = stored ? fingerprintKey(fingerprint(stored.payload)) : null;

      if (storedKey !== write.expectedKey) {
        continue;
      }

      if (write.payload) {
        this.items.set(key, { id: write.id, kind: write.kind, payload: write.payload });
      } else {
        this.items.delete(key);
      }

      written.add(key);
    }

    return Promise.resolve(written);
  }

  public saveState(cursor: string | null, bases: ReadonlyMap<string, LibrarySyncBase | null>) {
    if (cursor !== null) {
      this.cursor = cursor;
    }

    for (const [key, base] of bases) {
      if (base) {
        this.bases.set(key, base);
      } else {
        this.bases.delete(key);
      }
    }

    return Promise.resolve();
  }

  public pull(since: string) {
    return Promise.resolve(this.cloud.pull(since, this.pageSize));
  }

  public push(changes: readonly LibrarySyncChange[]) {
    return Promise.resolve(this.cloud.push(changes));
  }

  public isCurrent() {
    return this.current;
  }
}

let clock = Date.parse("2026-10-26T10:00:00.000Z");
const now = () => {
  clock += 1_000;
  return new Date(clock);
};
const sync = (device: FakeDevice) => runLibrarySync(device, { now });

/* ------------------------------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------------------------------- */

describe("library sync fingerprints", () => {
  it("reads equal values the same whatever their key order", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(
      stableStringify({ a: [{ d: 2 }], b: 1 })
    );
    expect(fingerprint(recipe({ favorite: true }))).toEqual(
      fingerprint({ favorite: true, ...recipe() })
    );
    expect(fingerprint(recipe({ favorite: true })).content).toBe(fingerprint(recipe()).content);
    expect(fingerprint(recipe({ favorite: true })).favorite).not.toBe(
      fingerprint(recipe()).favorite
    );
  });
});

describe("utf8ByteLength", () => {
  it("counts what the text takes in UTF-8", () => {
    for (const text of ["soup", "crème brûlée", "塩ラーメン", "🍜 noodles", "\ud800 lone"]) {
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
    }
  });
});

describe("mergeLibraryPayloads", () => {
  const base = recipe({ notes: "salt", tags: ["Soup"] });
  const merge = (local: LibrarySyncPayload, remote: LibrarySyncPayload) =>
    mergeLibraryPayloads(fingerprint(base), local, remote, LIBRARY_RECIPE_SYNC_GROUPS);

  it("keeps changes each side made to different fields", () => {
    expect(merge({ ...base, favorite: true }, { ...base, notes: "more salt", rating: 4 })).toEqual({
      ...base,
      favorite: true,
      notes: "more salt",
      rating: 4
    });
  });

  it("keeps the local version of a field both sides changed", () => {
    expect(merge({ ...base, notes: "here" }, { ...base, notes: "there" }).notes).toBe("here");
  });

  it("takes a removal made on the other side", () => {
    const local = { ...base };
    const remote = { ...base };
    delete remote.notes;

    expect(merge(local, remote)).not.toHaveProperty("notes");
  });

  it("combines tags, favorites and cooks both sides added", () => {
    const merged = merge(
      {
        ...base,
        cookLog: [{ cookedAt: "2026-10-20T18:00:00.000Z" }],
        lastCookedAt: "2026-10-20T18:00:00.000Z",
        tags: ["Soup", "Quick"],
        timesCooked: 1
      },
      {
        ...base,
        cookLog: [{ cookedAt: "2026-10-22T18:00:00.000Z", note: "good" }],
        favorite: true,
        lastCookedAt: "2026-10-22T18:00:00.000Z",
        tags: ["soup", "Winter"],
        timesCooked: 1
      }
    );

    expect(merged.tags).toEqual(["Soup", "Quick", "Winter"]);
    expect(merged.favorite).toBe(true);
    expect(merged.cookLog).toEqual([
      { cookedAt: "2026-10-20T18:00:00.000Z" },
      { cookedAt: "2026-10-22T18:00:00.000Z", note: "good" }
    ]);
    expect(merged.timesCooked).toBe(2);
    expect(merged.lastCookedAt).toBe("2026-10-22T18:00:00.000Z");
  });

  it("doesn't count a cook a full log dropped on the other side as a new one", () => {
    const day = (index: number) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
    const shared = Array.from({ length: 100 }, (_, index) => ({ cookedAt: day(index) }));
    const merged = merge(
      { ...base, cookLog: [...shared.slice(1), { cookedAt: day(100) }], timesCooked: 101 },
      {
        ...base,
        cookLog: [...shared.slice(2), { cookedAt: day(101) }, { cookedAt: day(102) }],
        timesCooked: 102
      }
    );

    expect(merged.timesCooked).toBe(103);
    expect(merged.cookLog).toHaveLength(100);
  });

  it("merges against nothing on a first sync", () => {
    const merged = mergeLibraryPayloads(
      null,
      recipe({ notes: "mine", tags: ["A"] }),
      recipe({ notes: "theirs", tags: ["B"] }),
      LIBRARY_RECIPE_SYNC_GROUPS
    );

    expect(merged.notes).toBe("mine");
    expect(merged.tags).toEqual(["A", "B"]);
  });
});

describe("resolveRemoteChange", () => {
  const payload = recipe();
  const base: LibrarySyncBase = {
    fingerprint: fingerprint(payload),
    updatedAt: "2026-10-26T09:00:00.000Z"
  };
  const change = (overrides: Partial<LibrarySyncChange> = {}): LibrarySyncChange => ({
    id: "soup",
    kind: "recipe",
    payload: recipe({ notes: "new" }),
    updatedAt: "2026-10-26T11:00:00.000Z",
    ...overrides
  });
  const deletion = change({ deleted: true, payload: undefined });

  it("deletes an item deleted elsewhere unless it changed here", () => {
    expect(resolveRemoteChange(deletion, payload, base)).toMatchObject({ payload: null });
    expect(resolveRemoteChange(deletion, recipe({ favorite: true }), base)).toBeNull();
  });

  it("adds an item it doesn't have, unless it was deleted here", () => {
    expect(resolveRemoteChange(change(), undefined, undefined)).toMatchObject({
      expectedKey: null,
      payload: recipe({ notes: "new" })
    });
    expect(resolveRemoteChange(change({ payload }), undefined, base)).toBeNull();
    // Edited elsewhere after the copy deleted here: the edit brings it back.
    expect(resolveRemoteChange(change(), undefined, base)).toMatchObject({
      payload: recipe({ notes: "new" })
    });
  });

  it("writes nothing when the merge is what is stored", () => {
    expect(resolveRemoteChange(change({ payload }), recipe({ favorite: true }), base)).toBeNull();
  });

  it("guards the write with what it merged", () => {
    const local = recipe({ favorite: true });

    expect(resolveRemoteChange(change(), local, base)).toEqual({
      expectedKey: fingerprintKey(fingerprint(local)),
      id: "soup",
      kind: "recipe",
      payload: recipe({ favorite: true, notes: "new" }),
      updatedAt: "2026-10-26T11:00:00.000Z"
    });
  });
});

describe("runLibrarySync", () => {
  it("brings one device's cookbook to another and back", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    laptop.put(
      "weeknights",
      { createdAt: "2026-10-01T12:00:00.000Z", name: "Weeknights", sortOrder: 0 },
      "collection"
    );

    await expect(sync(laptop)).resolves.toEqual({ pulled: 0, pushed: 2, rejected: 0 });
    await sync(phone);

    expect(phone.get("soup")).toEqual(recipe());
    expect(phone.get("weeknights", "collection")).toMatchObject({ name: "Weeknights" });

    phone.put("soup", recipe({ favorite: true }));
    laptop.put("soup", recipe({ notes: "less salt" }));
    await sync(phone);
    await sync(laptop);
    await sync(phone);

    expect(laptop.get("soup")).toEqual(recipe({ favorite: true, notes: "less salt" }));
    expect(phone.get("soup")).toEqual(recipe({ favorite: true, notes: "less salt" }));

    // Settled: nothing more goes either way.
    const pushes = cloud.pushes;
    await sync(laptop);
    await sync(phone);
    expect(cloud.pushes).toBe(pushes);
  });

  it("passes deletions on, and an edit elsewhere outlives a deletion", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    laptop.put("stew", recipe({ recipe: { title: "Stew" } }));
    await sync(laptop);
    await sync(phone);

    laptop.remove("soup");
    laptop.remove("stew");
    phone.put("stew", recipe({ recipe: { title: "Stew" }, rating: 5 }));
    await sync(laptop);
    await sync(phone);
    await sync(laptop);

    expect(phone.get("soup")).toBeUndefined();
    expect(phone.get("stew")).toMatchObject({ rating: 5 });
    expect(laptop.get("stew")).toMatchObject({ rating: 5 });
  });

  it("sends an item made again after a deletion as newer than the deletion", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    await sync(laptop);
    laptop.remove("soup");
    await sync(laptop);
    laptop.put("soup", recipe({ notes: "again" }));
    await sync(laptop);

    expect(cloud.items.get("recipe:soup")?.change).toMatchObject({
      payload: recipe({ notes: "again" })
    });
  });

  it("keeps each push request under the size limit", async () => {
    const cloud = new FakeCloud();
    const device = new FakeDevice(cloud);

    for (const id of ["r1", "r2", "r3"]) {
      device.put(id, recipe({ notes: "塩".repeat(1_000) }));
    }

    await runLibrarySync(device, { now, pushBatchBytes: 7_000 });

    expect(cloud.pushes).toBe(2);
    expect(cloud.items.size).toBe(3);
  });

  it("merges every page of a long change feed", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud, 2);

    for (const id of ["a", "b", "c", "d", "e"]) {
      laptop.put(id, recipe({ notes: id }));
    }

    await sync(laptop);
    await expect(sync(phone)).resolves.toMatchObject({ pulled: 5, pushed: 0 });
    expect(phone.items.size).toBe(5);
    expect(phone.cursor).toBe("5");
  });

  it("holds a version the cloud turned away until it changes again", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    cloud.refuse = (change) => change.payload?.notes === "too long";
    laptop.put("soup", recipe({ notes: "too long" }));

    await expect(sync(laptop)).resolves.toMatchObject({ pushed: 0, rejected: 1 });
    const pushes = cloud.pushes;
    await sync(laptop);
    expect(cloud.pushes).toBe(pushes);

    laptop.put("soup", recipe({ notes: "short" }));
    await expect(sync(laptop)).resolves.toMatchObject({ pushed: 1, rejected: 0 });
  });

  it("merges again when an item changed while the sync was out", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    await sync(laptop);
    await sync(phone);

    laptop.put("soup", recipe({ notes: "from the laptop" }));
    await sync(laptop);
    phone.beforeApply = () => {
      phone.beforeApply = null;
      phone.put("soup", recipe({ rating: 3 }));
    };
    await sync(phone);

    expect(phone.get("soup")).toEqual(recipe({ notes: "from the laptop", rating: 3 }));
    await sync(laptop);
    expect(laptop.get("soup")).toEqual(recipe({ notes: "from the laptop", rating: 3 }));
  });

  it("keeps a change it couldn't merge for the next run, and sends nothing over it", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    await sync(laptop);
    await sync(phone);

    laptop.put("soup", recipe({ notes: "from the laptop" }));
    await sync(laptop);
    let rating = 0;
    phone.beforeApply = () => {
      rating += 1;
      phone.put("soup", recipe({ rating }));
    };
    await sync(phone);

    expect(phone.get("soup")).toEqual(recipe({ rating: 3 }));
    expect(phone.bases.get("recipe:soup")?.pending).toMatchObject({ id: "soup" });
    expect(cloud.items.get("recipe:soup")?.change.payload).toEqual(
      recipe({ notes: "from the laptop" })
    );

    phone.beforeApply = null;
    await sync(phone);
    expect(phone.get("soup")).toEqual(recipe({ notes: "from the laptop", rating: 3 }));
    expect(phone.bases.get("recipe:soup")?.pending).toBeUndefined();
    await sync(laptop);
    expect(laptop.get("soup")).toEqual(recipe({ notes: "from the laptop", rating: 3 }));
  });

  it("merges a newer copy the push lost to", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    await sync(laptop);
    await sync(phone);

    phone.put("soup", recipe({ favorite: true }));
    laptop.put("soup", recipe({ notes: "salt" }));
    // The phone's copy lands after the laptop pulled but before it pushes.
    const pull = laptop.pull.bind(laptop);
    laptop.pull = async (since) => {
      const page = await pull(since);
      cloud.push([
        {
          id: "soup",
          kind: "recipe",
          payload: recipe({ favorite: true }),
          updatedAt: "2099-01-01T00:00:00.000Z"
        }
      ]);
      laptop.pull = pull;
      return page;
    };

    await sync(laptop);
    expect(laptop.get("soup")).toEqual(recipe({ favorite: true, notes: "salt" }));
  });

  it("merges an edit another device sent between its pull and its push", async () => {
    const cloud = new FakeCloud();
    const web = new FakeDevice(cloud);
    const phone = new FakeDevice(cloud);
    web.put("r1", recipe());
    await sync(web);
    await sync(phone);

    web.put("r1", recipe({ notes: "more salt" }));
    phone.put("r1", recipe({ favorite: true }));
    // The web's clock runs a minute behind, so its copy reads as older than the phone's.
    const push = phone.push.bind(phone);
    phone.push = async (changes) => {
      await runLibrarySync(web, { now: () => new Date(clock - 60_000) });
      return push(changes);
    };
    await sync(phone);
    phone.push = push;

    expect(phone.get("r1")).toEqual(recipe({ favorite: true, notes: "more salt" }));

    await sync(phone);
    await sync(web);

    expect(web.get("r1")).toEqual(phone.get("r1"));
  });

  it("sends everything again when the cloud lost what it had", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    laptop.put("stew", recipe({ recipe: { title: "Stew" } }));
    await sync(laptop);
    await sync(laptop);
    expect(laptop.cursor).toBe("2");

    const emptied = new FakeCloud();
    laptop.pull = (since) => Promise.resolve(emptied.pull(since));
    laptop.push = (changes) => Promise.resolve(emptied.push(changes));

    await expect(sync(laptop)).resolves.toMatchObject({ pushed: 2 });
    expect(emptied.items.size).toBe(2);
  });

  it("stops when another account signs in", async () => {
    const cloud = new FakeCloud();
    const laptop = new FakeDevice(cloud);
    laptop.put("soup", recipe());
    laptop.pull = (since) => {
      laptop.current = false;
      return Promise.resolve(cloud.pull(since));
    };

    await expect(sync(laptop)).rejects.toBeInstanceOf(LibrarySyncCancelledError);
    expect(cloud.items.size).toBe(0);
  });
});
