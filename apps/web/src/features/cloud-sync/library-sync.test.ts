import { SAMPLE_RECIPES } from "@linkdish/recipe-domain/src/samples";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExtractorApiError } from "../../api/errors";
import { publishCurrentAccount } from "../../auth/account-scope";
import { createCollection, getCollections } from "../../data/collections-store";
import { resetLinkDishWebDbForTests } from "../../storage/linkdish-db";
import { fakeIdb } from "../../storage/testing/fake-idb";
import {
  deleteSavedRecipe,
  getSavedRecipeById,
  getSavedRecipes,
  putSavedRecipe,
  saveRecipe,
  setRecipeFavorite,
  setRecipePreferredServings,
  updateRecipeNotes
} from "../library/saved-recipe-store";

import {
  forgetDeletedAccountLibrary,
  resetLibrarySyncForTests,
  setLibrarySyncAccount,
  switchToSignedInCookbook,
  syncLibraryNow
} from "./library-sync";
import { getLibrarySyncStatus, resetLibrarySyncStatusForTests } from "./library-sync-status";
import { readLibraryLink } from "./library-sync-storage";

import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type {
  LibraryChange,
  LibraryRecipe,
  PushLibraryChangesRequest
} from "@linkdish/api-contracts";

const apiMocks = vi.hoisted(() => ({
  pullLibraryChanges: vi.fn(),
  pushLibraryChanges: vi.fn()
}));

vi.mock("../../api/client", () => ({ apiClient: apiMocks }));
vi.mock("idb", async () => (await import("../../storage/testing/fake-idb")).fakeIdbModule);

const sample = SAMPLE_RECIPES[0];

/** Each account's cloud cookbook, as the API keeps it: the newest copy of an item wins. */
const createCloud = () => {
  const accounts = new Map<string, Map<string, { change: LibraryChange; rev: number }>>();
  let rev = 0;
  let signedIn = "u1";
  const items = (account = signedIn) => {
    let found = accounts.get(account);

    if (!found) {
      found = new Map();
      accounts.set(account, found);
    }

    return found;
  };
  const store = (change: LibraryChange, account = signedIn) => {
    rev += 1;
    items(account).set(`${change.kind}:${change.id}`, { change: structuredClone(change), rev });
  };

  apiMocks.pullLibraryChanges.mockImplementation((since: string) => {
    const after = Number(since);
    const page = [...items().values()]
      .filter((entry) => entry.rev > after)
      .sort((left, right) => left.rev - right.rev);

    return Promise.resolve({
      changes: page.map((entry) => structuredClone(entry.change)),
      cursor: String(page.at(-1)?.rev ?? after),
      hasMore: false
    });
  });
  apiMocks.pushLibraryChanges.mockImplementation((input: PushLibraryChangesRequest) => {
    const result = {
      accepted: [] as Array<{ id: string; kind: string }>,
      newer: [] as LibraryChange[],
      rejected: []
    };

    for (const change of input.changes) {
      const stored = items().get(`${change.kind}:${change.id}`);

      if (stored && stored.change.updatedAt > change.updatedAt) {
        result.newer.push(stored.change);
      } else {
        store(change);
        result.accepted.push({ id: change.id, kind: change.kind });
      }
    }

    return Promise.resolve(result);
  });

  return {
    get: (kind: string, id: string, account = signedIn) =>
      items(account).get(`${kind}:${id}`)?.change,
    ids: (account = signedIn) => [...items(account).keys()].sort(),
    signIn: (account: string) => {
      signedIn = account;
    },
    store
  };
};

const libraryRecipe = (overrides: Partial<LibraryRecipe> = {}): LibraryRecipe => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  fetchMode: "http",
  provenance: ["jsonld"],
  recipe: { ...sample.recipe, title: "Phone soup", sourceUrl: "https://example.com/phone-soup" },
  strategy: "recipe-schema",
  warnings: [],
  ...overrides
});

const save = async (title: string) => {
  const saved = await saveRecipe(
    {
      extraction: {
        fetchMode: "http",
        provenance: ["jsonld"],
        strategy: "recipe-schema",
        warnings: []
      },
      recipe: { ...sample.recipe, sourceUrl: `https://example.com/${title}`, title },
      sourceUrl: `https://example.com/${title}`
    },
    true
  );

  return saved.recipe as WebSavedRecipe;
};

const signIn = (userId: string | null) => {
  publishCurrentAccount(userId);
  setLibrarySyncAccount({
    credentialsKey: userId ? `key:${userId}` : null,
    isAuthenticated: userId !== null,
    loading: false,
    userId
  });
};

let cloud: ReturnType<typeof createCloud>;

beforeEach(() => {
  fakeIdb.reset();
  resetLinkDishWebDbForTests();
  resetLibrarySyncForTests();
  resetLibrarySyncStatusForTests();
  apiMocks.pullLibraryChanges.mockReset();
  apiMocks.pushLibraryChanges.mockReset();
  cloud = createCloud();
});

afterEach(() => {
  resetLibrarySyncForTests();
  publishCurrentAccount(null);
  vi.useRealTimers();
});

describe("cookbook cloud sync", () => {
  it("links the cookbook to the first account to sign in and sends it, starters aside", async () => {
    const soup = await save("Soup");
    await putSavedRecipe({ ...soup, id: "starter-pancakes", isStarter: true });
    const weeknights = await createCollection({ emoji: "🌙", name: "Weeknights" });

    signIn("u1");
    await syncLibraryNow();

    expect(await readLibraryLink()).toMatchObject({ account: "u1" });
    expect(cloud.ids()).toEqual([`collection:${weeknights.id}`, `recipe:${soup.id}`]);
    expect(cloud.get("recipe", soup.id)?.recipe).toMatchObject({
      createdAt: soup.createdAt,
      recipe: { title: "Soup" }
    });
    expect(getLibrarySyncStatus()).toMatchObject({ account: "u1", held: 0, phase: "synced" });
  });

  it("brings in the account's recipes from its other devices, and their changes", async () => {
    cloud.store({
      id: "saved-1",
      kind: "recipe",
      recipe: libraryRecipe({ favorite: true, tags: ["Soup"], timesCooked: 2 }),
      updatedAt: "2026-10-26T10:00:00.000Z"
    });
    signIn("u1");
    await syncLibraryNow();

    expect(await getSavedRecipeById("saved-1")).toMatchObject({
      favorite: true,
      recipe: { title: "Phone soup" },
      sourceHost: "example.com",
      sourceUrl: "https://example.com/phone-soup",
      tags: ["Soup"],
      timesCooked: 2
    });

    // A note added on the phone, and the favorite taken off here: both are kept.
    cloud.store({
      id: "saved-1",
      kind: "recipe",
      recipe: libraryRecipe({ favorite: true, notes: "More salt", tags: ["Soup"], timesCooked: 2 }),
      updatedAt: "2026-10-26T11:00:00.000Z"
    });
    await setRecipeFavorite("saved-1", false);
    await syncLibraryNow();

    expect(await getSavedRecipeById("saved-1")).toMatchObject({ notes: "More salt" });
    expect((await getSavedRecipeById("saved-1"))?.favorite).toBeUndefined();
    expect(cloud.get("recipe", "saved-1")?.recipe).toMatchObject({ notes: "More salt" });
    expect(cloud.get("recipe", "saved-1")?.recipe?.favorite).toBeUndefined();
  });

  it("passes deletions on both ways", async () => {
    const soup = await save("Soup");
    const stew = await save("Stew");
    signIn("u1");
    await syncLibraryNow();

    await deleteSavedRecipe(soup.id, { snapshot: false });
    cloud.store({
      deleted: true,
      id: stew.id,
      kind: "recipe",
      updatedAt: "2099-01-01T00:00:00.000Z"
    });
    await syncLibraryNow();

    expect(cloud.get("recipe", soup.id)).toMatchObject({ deleted: true });
    expect(await getSavedRecipeById(stew.id)).toBeUndefined();
  });

  it("keeps a recipe the cloud would turn away here, and sends the rest", async () => {
    const soup = await save("Soup");
    const stew = await save("Stew");
    await setRecipePreferredServings(soup.id, 50_000);

    signIn("u1");
    await syncLibraryNow();

    expect(cloud.ids()).toEqual([`recipe:${stew.id}`]);
    expect(getLibrarySyncStatus()).toMatchObject({ held: 1, phase: "synced" });

    // Not sent again until it changes.
    const pushes = apiMocks.pushLibraryChanges.mock.calls.length;
    await syncLibraryNow();
    expect(apiMocks.pushLibraryChanges.mock.calls.length).toBe(pushes);

    await setRecipePreferredServings(soup.id, 4);
    await syncLibraryNow();
    expect(cloud.ids()).toEqual([`recipe:${soup.id}`, `recipe:${stew.id}`].sort());
    expect(getLibrarySyncStatus()).toMatchObject({ held: 0 });
  });

  it("never syncs another account's cookbook, and can replace it with the account's own", async () => {
    const soup = await save("Soup");
    await putSavedRecipe({ ...soup, id: "starter-pancakes", isStarter: true });
    signIn("u1");
    await syncLibraryNow();
    await updateRecipeNotes(soup.id, "Not synced yet");

    signIn(null);
    expect(getLibrarySyncStatus()).toMatchObject({ account: null, phase: "off" });

    cloud.signIn("u2");
    cloud.store({
      id: "saved-2",
      kind: "recipe",
      recipe: libraryRecipe(),
      updatedAt: "2026-10-26T10:00:00.000Z"
    });
    apiMocks.pullLibraryChanges.mockClear();
    signIn("u2");
    await syncLibraryNow();

    expect(getLibrarySyncStatus()).toMatchObject({ account: "u2", phase: "other_account" });
    expect(apiMocks.pullLibraryChanges).not.toHaveBeenCalled();
    expect(await getSavedRecipeById(soup.id)).toMatchObject({ notes: "Not synced yet" });

    await switchToSignedInCookbook();

    expect((await getSavedRecipes()).map((recipe) => recipe.id).sort()).toEqual([
      "saved-2",
      "starter-pancakes"
    ]);
    expect(await readLibraryLink()).toMatchObject({ account: "u2" });
    expect(getLibrarySyncStatus()).toMatchObject({ phase: "synced" });
    expect(cloud.ids("u1")).toEqual([`recipe:${soup.id}`]);
  });

  it("takes a deleted collection off the recipes filed in it", async () => {
    const weeknights = await createCollection({ name: "Weeknights" });
    const soup = await save("Soup");
    await putSavedRecipe({ ...soup, collectionIds: [weeknights.id] });
    signIn("u1");
    await syncLibraryNow();

    cloud.store({
      deleted: true,
      id: weeknights.id,
      kind: "collection",
      updatedAt: "2099-01-01T00:00:00.000Z"
    });
    await syncLibraryNow();

    expect(await getCollections()).toEqual([]);
    expect((await getSavedRecipeById(soup.id))?.collectionIds).toBeUndefined();
  });

  it("stays quiet while cloud sync is switched off", async () => {
    await save("Soup");
    apiMocks.pullLibraryChanges.mockRejectedValue(
      new ExtractorApiError("Extractor API request failed.", 404, undefined, { kind: "http" })
    );

    signIn("u1");
    await syncLibraryNow();
    await syncLibraryNow();

    expect(apiMocks.pullLibraryChanges).toHaveBeenCalledTimes(1);
    expect(apiMocks.pushLibraryChanges).not.toHaveBeenCalled();
    expect(getLibrarySyncStatus()).toMatchObject({ phase: "off" });
  });

  it("unlinks the cookbook from a deleted account and keeps the recipes", async () => {
    const soup = await save("Soup");
    signIn("u1");
    await syncLibraryNow();

    await forgetDeletedAccountLibrary("u1");

    expect(await readLibraryLink()).toBeNull();
    expect(await getSavedRecipeById(soup.id)).toBeDefined();
  });
});
