import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveRecipe } from "../features/library/saved-recipe-store";
import { resetLinkDishWebDbForTests, SAVED_RECIPES_STORE_NAME } from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  getCachedSavedRecipe,
  loadSavedRecipes,
  logCooked,
  removeSavedRecipe,
  resetLibraryStoreForTests,
  setFavorite,
  setRating,
  setTags,
  toggleFavorite,
  useSavedRecipe,
  useSavedRecipes
} from "./library-store";

import type { WebSavedRecipe } from "../features/library/saved-recipe-types";

vi.mock("idb", async () => (await import("../storage/testing/fake-idb")).fakeIdbModule);

vi.mock("../api/client", () => ({
  apiClient: {}
}));

const analytics = vi.hoisted(() => ({ trackWebEvent: vi.fn<(event: unknown) => void>() }));
vi.mock("../analytics/client", () => ({ trackWebEvent: analytics.trackWebEvent }));

const saveInput = (index: number) => ({
  extraction: {
    fetchMode: "http" as const,
    provenance: ["jsonld" as const],
    strategy: "recipe-schema" as const,
    warnings: []
  },
  recipe: {
    confidence: {
      fieldProvenance: {
        cookTimeMinutes: null,
        ingredients: "jsonld" as const,
        nutrition: null,
        prepTimeMinutes: null,
        servings: null,
        steps: "jsonld" as const,
        title: "jsonld" as const
      },
      missingFields: [],
      notes: [],
      score: 0.9,
      summary: "ok"
    },
    cookTimeMinutes: null,
    ingredients: [{ text: "1 onion" }],
    nutrition: null,
    prepTimeMinutes: null,
    servings: "2",
    sourceType: "recipe-webpage" as const,
    sourceUrl: `https://example.com/${index}`,
    steps: [{ index: 1, text: "Chop" }],
    title: `Soup ${index}`
  },
  sourceUrl: `https://example.com/${index}`
});

describe("library-store", () => {
  let channel: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: () => void;
    close: () => void;
  };

  beforeEach(() => {
    fakeIdb.reset();
    localStorage.clear();
    resetLinkDishWebDbForTests();
    resetDataChangeFeedForTests();
    resetLibraryStoreForTests();
    channel = { close: vi.fn(), onmessage: null, postMessage: vi.fn() };
    setDataChannelFactoryForTests(() => channel);
    let uuid = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
    });
    analytics.trackWebEvent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads once, seeding the starter recipes on first run", async () => {
    const { result, rerender } = renderHook(() => useSavedRecipes());

    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.recipes).toHaveLength(3);
    expect(result.current.recipes.every((recipe) => recipe.isStarter)).toBe(true);

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    const second = renderHook(() => useSavedRecipes());
    expect(second.result.current.status).toBe("ready");
    expect(fakeIdb.openCalls).toHaveLength(1);
  });

  it("applies writes made anywhere in the tab without re-reading the library", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const db = await (await import("../storage/linkdish-db")).getLinkDishWebDb();
    const getAll = vi.spyOn(db, "getAll");

    await act(async () => {
      await saveRecipe(
        { ...saveInput(1), sourceImages: [{ dataUrl: "data:x", mimeType: "image/png" }] },
        true
      );
    });

    expect(result.current.recipes).toHaveLength(4);
    expect(result.current.recipes[0]?.recipe.title).toBe("Soup 1");
    expect(result.current.recipes[0]).not.toHaveProperty("sourceImages");
    expect(getAll).not.toHaveBeenCalled();
  });

  it("updates favorites optimistically and rolls back when storage fails", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const id = result.current.recipes[0]!.id;

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = toggleFavorite(id);
    });
    expect(getCachedSavedRecipe(id)?.favorite).toBe(true);
    await act(async () => {
      await pending;
    });
    expect(fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id)?.favorite).toBe(true);

    fakeIdb.failNextPut(SAVED_RECIPES_STORE_NAME, new Error("disk full"));
    await act(async () => {
      await expect(setFavorite(id, false)).rejects.toThrow("disk full");
    });
    expect(getCachedSavedRecipe(id)?.favorite).toBe(true);
  });

  it("reports favorites, ratings and tags once they are saved", async () => {
    await loadSavedRecipes();
    const id = (await import("./library-store")).getSavedRecipesSnapshot().data[0]!.id;

    await setFavorite(id, true);
    await setRating(id, 4);
    await setTags(id, ["Cozy", "cozy", "Quick"]);
    fakeIdb.failNextPut(SAVED_RECIPES_STORE_NAME, new Error("disk full"));
    await expect(setFavorite(id, false)).rejects.toThrow("disk full");

    const events = analytics.trackWebEvent.mock.calls.map(([event]) => [
      (event as { eventName: string }).eventName,
      (event as { properties: unknown }).properties
    ]);
    expect(events).toEqual([
      ["recipe_favorited", { favorited: true }],
      ["recipe_rated", { rating: 4 }],
      ["recipe_tagged", { tag_count: 2 }]
    ]);
  });

  it("keeps metadata helpers in sync with storage", async () => {
    await loadSavedRecipes();
    const id = (await import("./library-store")).getSavedRecipesSnapshot().data[0]!.id;
    const { result } = renderHook(() => useSavedRecipe(id));

    await act(async () => {
      await setTags(id, ["Cozy", "cozy"]);
      await logCooked(id, { cookedAt: "2026-09-10T18:00:00.000Z" });
    });

    expect(result.current.recipe).toMatchObject({
      lastCookedAt: "2026-09-10T18:00:00.000Z",
      tags: ["Cozy"],
      timesCooked: 1
    });
    expect(fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id)).toMatchObject({
      tags: ["Cozy"],
      timesCooked: 1
    });
  });

  it("removes recipes and restores them when the delete fails", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const id = result.current.recipes[0]!.id;

    const db = await (await import("../storage/linkdish-db")).getLinkDishWebDb();
    vi.spyOn(db, "transaction").mockImplementationOnce(() => {
      throw new DOMException("gone", "InvalidStateError");
    });
    await act(async () => {
      await expect(removeSavedRecipe(id)).rejects.toThrow("gone");
    });
    expect(result.current.recipes.map((recipe) => recipe.id)).toContain(id);

    await act(async () => {
      await removeSavedRecipe(id);
    });
    expect(result.current.recipes.map((recipe) => recipe.id)).not.toContain(id);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, id)).toBeUndefined();
  });

  it("refreshes when another tab changes the library", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      {
        ...result.current.recipes[0],
        id: "from-other-tab",
        updatedAt: "2099-01-01T00:00:00.000Z"
      }
    ]);
    act(() => {
      channel.onmessage?.({ data: { topic: "savedRecipes", v: 1 } } as MessageEvent);
    });

    await waitFor(() => expect(result.current.recipes[0]?.id).toBe("from-other-tab"));
  });

  it("keeps the recipe object when storage echoes a metadata write back", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = result.current.recipes[0];
    const id = before?.id ?? "";
    const others = result.current.recipes.slice(1);

    await act(async () => {
      await setFavorite(id, true);
    });

    const after = result.current.recipes.find((recipe) => recipe.id === id);
    expect(after?.favorite).toBe(true);
    // The IndexedDB echo is a structured clone; its unchanged recipe keeps the cached object, so
    // cards, the facts cache and the search index are not rebuilt for a heart tap.
    expect(after?.recipe).toBe(before?.recipe);
    expect(result.current.recipes.slice(1)).toEqual(others);
    result.current.recipes.slice(1).forEach((recipe, index) => {
      expect(recipe).toBe(others[index]);
    });
  });

  it("re-reads only the recipes another tab wrote, keeping every other object", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const [first, second, third] = result.current.recipes;
    const db = await (await import("../storage/linkdish-db")).getLinkDishWebDb();
    const getAll = vi.spyOn(db, "getAll");

    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [
      { ...first, lastOpenedAt: "2026-09-28T10:00:00.000Z" } as WebSavedRecipe
    ]);
    act(() => {
      channel.onmessage?.({
        data: { topic: "savedRecipes", upsertedIds: [first?.id], v: 1 }
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(getCachedSavedRecipe(first?.id ?? "")?.lastOpenedAt).toBe("2026-09-28T10:00:00.000Z")
    );
    expect(getAll).not.toHaveBeenCalled();
    const opened = result.current.recipes.find((recipe) => recipe.id === first?.id);
    expect(opened?.recipe).toBe(first?.recipe);
    expect(result.current.recipes).toContain(second);
    expect(result.current.recipes).toContain(third);
  });

  it("keeps unchanged objects when another tab forces a full reload", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const before = result.current.recipes;

    act(() => {
      channel.onmessage?.({ data: { topic: "savedRecipes", v: 1 } } as MessageEvent);
    });

    const db = await (await import("../storage/linkdish-db")).getLinkDishWebDb();
    const getAll = vi.spyOn(db, "getAll");
    await waitFor(() => expect(getAll).toHaveBeenCalled());
    await act(async () => {
      await loadSavedRecipes();
    });
    // Nothing changed, so the list (and every record in it) is the same object.
    expect(result.current.recipes).toBe(before);
  });

  it("surfaces a load error and recovers on retry", async () => {
    fakeIdb.failNextOpen(new DOMException("blocked", "UnknownError"));
    const { result } = renderHook(() => useSavedRecipes());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBeInstanceOf(DOMException);
    expect(result.current.recipes).toEqual([]);

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.recipes).toHaveLength(3);
  });
});
