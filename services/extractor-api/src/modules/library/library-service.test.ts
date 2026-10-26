import { afterEach, describe, expect, it, vi } from "vitest";

import { SAMPLE_RECIPES } from "../../../../../packages/recipe-domain/src/samples.js";

import type { LibraryChange } from "../../../../../packages/api-contracts/src/index.js";

const contractsPath = "../../../../../packages/api-contracts/src/index.js";

const importLibrary = async (
  env?: Record<string, string>,
  limits?: Partial<Record<"MAX_LIBRARY_PULL_CHANGES" | "MAX_LIBRARY_RECIPES", number>>
) => {
  vi.resetModules();
  vi.doUnmock(contractsPath);

  if (limits) {
    vi.doMock(contractsPath, async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      ...limits
    }));
  }

  for (const [key, value] of Object.entries({
    LIBRARY_SYNC_ENABLED: "true",
    NODE_ENV: "test",
    UPSTASH_REDIS_REST_TOKEN: "",
    UPSTASH_REDIS_REST_URL: "https://upstash.invalid",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  return import("./library-service.js");
};

const sampleRecipe = SAMPLE_RECIPES[0].recipe;

const recipeChange = (
  id: string,
  updatedAt: string,
  overrides: Partial<NonNullable<LibraryChange["recipe"]>> = {}
): LibraryChange => ({
  id,
  kind: "recipe",
  recipe: {
    createdAt: "2026-10-01T12:00:00.000Z",
    fetchMode: "http",
    provenance: ["jsonld"],
    recipe: sampleRecipe,
    strategy: "recipe-schema",
    warnings: [],
    ...overrides
  },
  updatedAt
});

const collectionChange = (id: string, updatedAt: string, name = "Weeknights"): LibraryChange => ({
  collection: { createdAt: "2026-10-01T12:00:00.000Z", name, sortOrder: 0 },
  id,
  kind: "collection",
  updatedAt
});

const tombstone = (id: string, updatedAt: string): LibraryChange => ({
  deleted: true,
  id,
  kind: "recipe",
  updatedAt
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("library sync", () => {
  it("returns what one device pushed to the account's other devices", async () => {
    const library = await importLibrary();

    const pushed = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T10:00:00.000Z", { favorite: true, tags: ["Quick"] }),
      collectionChange("collection_a", "2026-10-26T10:00:00.000Z")
    ]);

    expect(pushed).toEqual({
      accepted: [
        { id: "recipe_a", kind: "recipe" },
        { id: "collection_a", kind: "collection" }
      ],
      newer: [],
      rejected: []
    });

    const pulled = await library.pullLibraryChanges("user_1", "0");

    expect(pulled.hasMore).toBe(false);
    expect(pulled.cursor).toBe("2");
    expect(pulled.changes.map((change) => [change.kind, change.id])).toEqual([
      ["recipe", "recipe_a"],
      ["collection", "collection_a"]
    ]);
    expect(pulled.changes[0]?.recipe?.tags).toEqual(["Quick"]);

    await expect(library.pullLibraryChanges("user_1", pulled.cursor)).resolves.toEqual({
      changes: [],
      cursor: "2",
      hasMore: false
    });
  });

  it("keeps each account's library to itself", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")]);

    await expect(library.pullLibraryChanges("user_2", "0")).resolves.toEqual({
      changes: [],
      cursor: "0",
      hasMore: false
    });
  });

  it("keeps the newest copy and hands the device the newer one it lost to", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T12:00:00.000Z", { notes: "from the phone" })
    ]);
    const stale = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T11:00:00.000Z", { notes: "from the laptop" })
    ]);

    expect(stale.accepted).toEqual([]);
    expect(stale.newer).toHaveLength(1);
    expect(stale.newer[0]?.recipe?.notes).toBe("from the phone");

    const newer = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T13:00:00.000Z", { notes: "edited again" })
    ]);

    expect(newer.accepted).toEqual([{ id: "recipe_a", kind: "recipe" }]);

    const pulled = await library.pullLibraryChanges("user_1", "0");
    expect(pulled.changes).toHaveLength(1);
    expect(pulled.changes[0]?.recipe?.notes).toBe("edited again");
    expect(pulled.cursor).toBe("2");
  });

  it("hands back the stored copy when a change was merged with an older one", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [
      { ...recipeChange("recipe_a", "2026-10-26T10:00:00.000Z"), baseUpdatedAt: null }
    ]);
    // Another device's edit lands after this device pulled the 10:00 copy.
    await library.pushLibraryChanges("user_1", [
      {
        ...recipeChange("recipe_a", "2026-10-26T11:00:00.000Z", { notes: "from the laptop" }),
        baseUpdatedAt: "2026-10-26T10:00:00.000Z"
      }
    ]);
    const unseen = await library.pushLibraryChanges("user_1", [
      {
        ...recipeChange("recipe_a", "2026-10-26T12:00:00.000Z", { favorite: true }),
        baseUpdatedAt: "2026-10-26T10:00:00.000Z"
      }
    ]);

    expect(unseen.accepted).toEqual([]);
    expect(unseen.newer[0]?.recipe?.notes).toBe("from the laptop");
    expect(unseen.newer[0]).not.toHaveProperty("baseUpdatedAt");

    const merged = await library.pushLibraryChanges("user_1", [
      {
        ...recipeChange("recipe_a", "2026-10-26T12:00:01.000Z", {
          favorite: true,
          notes: "from the laptop"
        }),
        baseUpdatedAt: "2026-10-26T11:00:00.000Z"
      }
    ]);

    expect(merged.accepted).toEqual([{ id: "recipe_a", kind: "recipe" }]);
    const pulled = await library.pullLibraryChanges("user_1", "0");
    expect(pulled.changes).toEqual([
      recipeChange("recipe_a", "2026-10-26T12:00:01.000Z", {
        favorite: true,
        notes: "from the laptop"
      })
    ]);
  });

  it("doesn't let a new item overwrite one with the same id it never saw", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")]);
    const clash = await library.pushLibraryChanges("user_1", [
      { ...recipeChange("recipe_a", "2026-10-26T11:00:00Z"), baseUpdatedAt: null }
    ]);

    expect(clash.accepted).toEqual([]);
    expect(clash.newer).toHaveLength(1);
  });

  it("accepts a retry of what it already stored without writing it again", async () => {
    const library = await importLibrary();
    const change = recipeChange("recipe_a", "2026-10-26T12:00:00.000Z");

    await library.pushLibraryChanges("user_1", [change]);
    const { cursor } = await library.pullLibraryChanges("user_1", "0");
    const retried = await library.pushLibraryChanges("user_1", [change]);

    expect(retried.accepted).toEqual([{ id: "recipe_a", kind: "recipe" }]);
    await expect(library.pullLibraryChanges("user_1", cursor)).resolves.toMatchObject({
      changes: []
    });
  });

  it("only counts the newest copy of an item sent twice in one batch", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T12:00:00.000Z", { notes: "newest" }),
      recipeChange("recipe_a", "2026-10-26T11:00:00.000Z", { notes: "older" })
    ]);

    const pulled = await library.pullLibraryChanges("user_1", "0");
    expect(pulled.changes.map((change) => change.recipe?.notes)).toEqual(["newest"]);
  });

  it("passes deletions on as tombstones", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")]);
    const { cursor } = await library.pullLibraryChanges("user_1", "0");
    await library.pushLibraryChanges("user_1", [tombstone("recipe_a", "2026-10-26T11:00:00Z")]);

    await expect(library.pullLibraryChanges("user_1", cursor)).resolves.toEqual({
      changes: [tombstone("recipe_a", "2026-10-26T11:00:00Z")],
      cursor: "2",
      hasMore: false
    });

    // An edit made before the deletion doesn't bring the recipe back.
    const stale = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T10:30:00Z")
    ]);
    expect(stale.newer).toEqual([tombstone("recipe_a", "2026-10-26T11:00:00Z")]);
  });

  it("turns away invalid changes on their own and keeps the rest of the batch", async () => {
    const library = await importLibrary();

    const pushed = await library.pushLibraryChanges("user_1", [
      { id: "broken", kind: "recipe", updatedAt: "2026-10-26T10:00:00Z" },
      recipeChange("recipe_a", "2026-10-26T10:00:00Z"),
      { ...tombstone("recipe_b", "2026-10-26T10:00:00Z"), recipe: recipeChange("x", "y").recipe }
    ]);

    expect(pushed.accepted).toEqual([{ id: "recipe_a", kind: "recipe" }]);
    expect(pushed.rejected).toEqual([
      expect.objectContaining({ id: "broken", index: 0, kind: "recipe", reason: "invalid" }),
      expect.objectContaining({
        id: "recipe_b",
        index: 2,
        message: "A deleted library item carries no payload.",
        reason: "invalid"
      })
    ]);
  });

  it("stops adding recipes at the library limit but still takes edits and deletions", async () => {
    const library = await importLibrary({}, { MAX_LIBRARY_RECIPES: 2 });

    await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T10:00:00Z"),
      recipeChange("recipe_b", "2026-10-26T10:00:00Z")
    ]);
    const full = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_c", "2026-10-26T10:00:00Z"),
      recipeChange("recipe_a", "2026-10-26T11:00:00Z", { favorite: true })
    ]);

    expect(full.accepted).toEqual([{ id: "recipe_a", kind: "recipe" }]);
    expect(full.rejected).toEqual([
      expect.objectContaining({ id: "recipe_c", index: 0, reason: "limit_reached" })
    ]);

    await library.pushLibraryChanges("user_1", [tombstone("recipe_b", "2026-10-26T12:00:00Z")]);
    const roomAgain = await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_c", "2026-10-26T12:00:00Z")
    ]);

    expect(roomAgain.accepted).toEqual([{ id: "recipe_c", kind: "recipe" }]);
  });

  it("pages through a long change feed", async () => {
    const library = await importLibrary({}, { MAX_LIBRARY_PULL_CHANGES: 2 });

    await library.pushLibraryChanges(
      "user_1",
      ["a", "b", "c"].map((id) => recipeChange(`recipe_${id}`, "2026-10-26T10:00:00Z"))
    );

    const first = await library.pullLibraryChanges("user_1", "0");
    expect(first).toMatchObject({ cursor: "2", hasMore: true });
    expect(first.changes.map((change) => change.id)).toEqual(["recipe_a", "recipe_b"]);

    const second = await library.pullLibraryChanges("user_1", first.cursor);
    expect(second).toMatchObject({ cursor: "3", hasMore: false });
    expect(second.changes.map((change) => change.id)).toEqual(["recipe_c"]);
  });

  it("starts a device over when its cursor is past anything the account has", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")]);

    await expect(library.pullLibraryChanges("user_1", "40")).resolves.toMatchObject({
      changes: [expect.objectContaining({ id: "recipe_a" })],
      cursor: "1",
      hasMore: false,
      reset: true
    });
  });

  it("deletes the whole library", async () => {
    const library = await importLibrary();

    await library.pushLibraryChanges("user_1", [
      recipeChange("recipe_a", "2026-10-26T10:00:00Z"),
      collectionChange("collection_a", "2026-10-26T10:00:00Z")
    ]);
    await library.pushLibraryChanges("user_2", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")]);

    await library.deleteLibraryForUser("user_1");

    await expect(library.pullLibraryChanges("user_1", "0")).resolves.toEqual({
      changes: [],
      cursor: "0",
      hasMore: false
    });
    await expect(library.pullLibraryChanges("user_2", "0")).resolves.toMatchObject({
      changes: [expect.objectContaining({ id: "recipe_a" })]
    });
  });

  it("is off unless switched on", async () => {
    const library = await importLibrary({ LIBRARY_SYNC_ENABLED: "false" });

    await expect(library.pullLibraryChanges("user_1", "0")).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(
      library.pushLibraryChanges("user_1", [recipeChange("recipe_a", "2026-10-26T10:00:00Z")])
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to keep cookbooks in process memory in production", async () => {
    const library = await importLibrary({ NODE_ENV: "production" });

    await expect(library.pullLibraryChanges("user_1", "0")).rejects.toMatchObject({
      statusCode: 503
    });
  });
});
