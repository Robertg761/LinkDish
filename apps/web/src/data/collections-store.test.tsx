import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSavedRecipeById, putSavedRecipe } from "../features/library/saved-recipe-store";
import { resetLinkDishWebDbForTests } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  CollectionValidationError,
  createCollection,
  deleteCollection,
  getCollections,
  reorderCollections,
  resetCollectionsStoreForTests,
  selectRecipesInCollection,
  updateCollection,
  useCollections
} from "./collections-store";

import type { WebSavedRecipe } from "../features/library/saved-recipe-types";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

vi.mock("../api/client", () => ({
  apiClient: {}
}));

const recipe = (id: string, collectionIds?: string[]): WebSavedRecipe =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
    id,
    recipe: { ingredients: [], steps: [], title: id },
    sourceHost: "example.com",
    sourceUrl: `https://example.com/${id}`,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...(collectionIds ? { collectionIds } : {})
  }) as unknown as WebSavedRecipe;

describe("collections-store", () => {
  beforeEach(() => {
    fakeIdb.reset();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetCollectionsStoreForTests();
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

  it("creates, renames and orders collections", async () => {
    const weeknight = await createCollection({ emoji: " 🍝 ", name: "  Weeknight   dinners " });
    const baking = await createCollection({ description: "Cakes & more", name: "Baking" });

    expect(weeknight).toMatchObject({ emoji: "🍝", name: "Weeknight dinners", sortOrder: 0 });
    expect(baking).toMatchObject({ description: "Cakes & more", sortOrder: 1 });

    const renamed = await updateCollection(weeknight.id, { emoji: "", name: "Quick dinners" });
    expect(renamed).toMatchObject({ name: "Quick dinners" });
    expect(renamed).not.toHaveProperty("emoji");
    expect(await updateCollection("missing", { name: "x" })).toBeUndefined();

    await reorderCollections([baking.id, weeknight.id]);
    expect((await getCollections()).map((collection) => collection.name)).toEqual([
      "Baking",
      "Quick dinners"
    ]);
  });

  it("validates names", async () => {
    await expect(createCollection({ name: "   " })).rejects.toBeInstanceOf(
      CollectionValidationError
    );
    await expect(createCollection({ name: "x".repeat(61) })).rejects.toThrow("60 characters");
  });

  it("removes a deleted collection from its recipes but keeps the recipes", async () => {
    const soups = await createCollection({ name: "Soups" });
    await putSavedRecipe(recipe("miso", [soups.id, "other"]));
    await putSavedRecipe(recipe("stew", [soups.id]));

    await deleteCollection(soups.id);

    expect(await getCollections()).toEqual([]);
    expect((await getSavedRecipeById("miso"))?.collectionIds).toEqual(["other"]);
    expect(await getSavedRecipeById("stew")).not.toHaveProperty("collectionIds");
  });

  it("serves a live list through useCollections", async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.collections).toEqual([]);

    await act(async () => {
      await createCollection({ name: "Zucchini season" });
      await createCollection({ name: "Apple season" });
    });

    expect(result.current.collections.map((collection) => collection.name)).toEqual([
      "Zucchini season",
      "Apple season"
    ]);

    await act(async () => {
      await deleteCollection(result.current.collections[0]!.id);
    });
    expect(result.current.collections.map((collection) => collection.name)).toEqual([
      "Apple season"
    ]);
  });

  it("selects the recipes in a collection", () => {
    const recipes = [recipe("a", ["c1"]), recipe("b"), recipe("c", ["c2", "c1"])];
    expect(selectRecipesInCollection(recipes, "c1").map((entry) => entry.id)).toEqual(["a", "c"]);
  });
});
