import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { putSavedRecipe } from "../features/library/saved-recipe-store";
import {
  COLLECTIONS_STORE_NAME,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";
import { isolateFakeIdbTransactions } from "../storage/testing/fake-idb-isolation";
import { createChannelPair } from "../storage/testing/two-tabs";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  createCollection,
  deleteCollection,
  reorderCollections,
  resetCollectionsStoreForTests,
  updateCollection,
  useCollections
} from "./collections-store";
import { addToCollection, loadSavedRecipes, resetLibraryStoreForTests } from "./library-store";

import type { WebCollection } from "./collections-store";
import type { WebSavedRecipe } from "../features/library/saved-recipe-types";

vi.mock(
  "idb",
  async () => (await import("../storage/testing/fake-idb-isolation")).isolatingFakeIdbModule
);

vi.mock("../api/client", () => ({
  apiClient: {}
}));

vi.mock("../analytics/client", () => ({ trackWebEvent: vi.fn() }));

/** Another tab on the same database: fresh copies of the connection, change feed and caches. */
const openOtherTab = async () => {
  vi.resetModules();
  const feed = await import("./change-feed");
  const collections = await import("./collections-store");
  const library = await import("./library-store");
  await (await import("../storage/linkdish-db")).getLinkDishWebDb();
  return { collections, feed, library };
};

const storedCollection = (id: string) => fakeIdb.record<WebCollection>(COLLECTIONS_STORE_NAME, id);

const recipe = (id: string): WebSavedRecipe =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
    id,
    recipe: { ingredients: [], steps: [], title: id },
    sourceHost: "example.com",
    sourceUrl: `https://example.com/${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z"
  }) as unknown as WebSavedRecipe;

describe("collection writes from two tabs", () => {
  let soups: WebCollection;
  let salads: WebCollection;

  beforeEach(async () => {
    fakeIdb.reset();
    isolateFakeIdbTransactions();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCollectionsStoreForTests();
    resetLibraryStoreForTests();
    setDataChannelFactoryForTests(() => null);
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    soups = await createCollection({ emoji: "🍲", name: "Soups" });
    salads = await createCollection({ name: "Salads" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setDataChannelFactoryForTests(() => null);
  });

  it("keeps a rename from one tab and a new emoji from the other", async () => {
    const other = await openOtherTab();
    const [here, there] = createChannelPair();
    setDataChannelFactoryForTests(() => here);
    other.feed.setDataChannelFactoryForTests(() => there);
    const hereView = renderHook(() => useCollections());
    const thereView = renderHook(() => other.collections.useCollections());
    await waitFor(() => {
      expect(hereView.result.current.collections).toHaveLength(2);
      expect(thereView.result.current.collections).toHaveLength(2);
    });

    await act(async () => {
      await Promise.all([
        updateCollection(soups.id, { name: "Soups & stews" }),
        other.collections.updateCollection(soups.id, { emoji: "🥣" })
      ]);
    });

    const both = { emoji: "🥣", name: "Soups & stews" };
    expect(storedCollection(soups.id)).toMatchObject(both);

    await waitFor(() => {
      expect(hereView.result.current.collections[0]).toMatchObject(both);
      expect(thereView.result.current.collections[0]).toMatchObject(both);
    });
  });

  it("keeps a rename made in one tab while the other reorders", async () => {
    const other = await openOtherTab();

    await Promise.all([
      reorderCollections([salads.id, soups.id]),
      other.collections.updateCollection(soups.id, { name: "Soups & stews" })
    ]);

    expect(storedCollection(soups.id)).toMatchObject({ name: "Soups & stews", sortOrder: 1 });
    expect(storedCollection(salads.id)).toMatchObject({ name: "Salads", sortOrder: 0 });
  });

  it("gives collections created in two tabs at once their own place in the order", async () => {
    const other = await openOtherTab();

    const [here, there] = await Promise.all([
      createCollection({ name: "Bakes" }),
      other.collections.createCollection({ name: "Drinks" })
    ]);

    expect(
      [storedCollection(here.id)?.sortOrder, storedCollection(there.id)?.sortOrder].sort()
    ).toEqual([2, 3]);
  });

  it("does not add a recipe to a collection the other tab deleted", async () => {
    await putSavedRecipe(recipe("pho"));
    const other = await openOtherTab();
    // The other tab still shows the collection (its picker was open before the delete).
    await other.library.loadSavedRecipes();

    await deleteCollection(soups.id);
    await other.library.addToCollection("pho", soups.id);

    expect(
      fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, "pho")?.collectionIds
    ).toBeUndefined();
  });

  it("keeps a membership another tab added while this one is stale", async () => {
    await putSavedRecipe(recipe("pho"));
    await loadSavedRecipes();
    const other = await openOtherTab();
    await other.library.loadSavedRecipes();

    // Neither tab has heard of the other's change when it adds the recipe to a collection.
    await Promise.all([
      addToCollection("pho", soups.id),
      other.library.addToCollection("pho", salads.id)
    ]);

    expect(
      [
        ...(fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, "pho")?.collectionIds ?? [])
      ].sort()
    ).toEqual([soups.id, salads.id].sort());
  });
});
