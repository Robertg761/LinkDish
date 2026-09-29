import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveRecipe, seedStarterRecipesIfNeeded } from "../features/library/saved-recipe-store";
import {
  getLinkDishWebDb,
  resetLinkDishWebDbForTests,
  SAVED_RECIPES_STORE_NAME
} from "../storage/linkdish-db";
import { fakeIdb } from "../storage/testing/fake-idb";
import { holdNextWrite, queueNextTransaction } from "../storage/testing/held-write";

import { resetDataChangeFeedForTests, setDataChannelFactoryForTests } from "./change-feed";
import {
  getCachedSavedRecipe,
  getSavedRecipesSnapshot,
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

/**
 * Loads the cookbook with nothing left to settle: seeding the starters during the first load
 * would re-read it once more in the background. Resolves with the ids as listed.
 */
const loadSettledCookbook = async (): Promise<string[]> => {
  await seedStarterRecipesIfNeeded();
  await loadSavedRecipes();
  return getSavedRecipesSnapshot().data.map((recipe) => recipe.id);
};

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

  it("restores only the recipe whose delete failed, keeping one deleted meanwhile", async () => {
    const [failing, deleted, kept] = await loadSettledCookbook();
    const shownIds = () => getSavedRecipesSnapshot().data.map((recipe) => recipe.id);
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const removing = removeSavedRecipe(failing!, { snapshot: false });
    await held.started;
    expect(shownIds()).toEqual([deleted, kept]);

    // Another delete is saved while the first one is pending.
    await removeSavedRecipe(deleted!);
    held.fail(new Error("disk full"));
    await expect(removing).rejects.toThrow("disk full");

    // Back in its place, and the other recipe stays deleted.
    expect(shownIds()).toEqual([failing, kept]);
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, deleted!)).toBeUndefined();
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, failing!)).toBeDefined();
  });

  it("rolls back a failed metadata change without losing a newer one saved meanwhile", async () => {
    const [id] = await loadSettledCookbook();
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const favoriting = setFavorite(id!, true);
    await held.started;
    expect(getCachedSavedRecipe(id!)?.favorite).toBe(true);

    await setRating(id!, 5);
    held.fail(new Error("disk full"));
    await expect(favoriting).rejects.toThrow("disk full");

    expect(getCachedSavedRecipe(id!)?.rating).toBe(5);
    expect(getCachedSavedRecipe(id!)).not.toHaveProperty("favorite");
    const stored = fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id!);
    expect(stored?.rating).toBe(5);
    expect(stored).not.toHaveProperty("favorite");
  });

  it("settles on the stored recipe when the change a rollback restores never saved", async () => {
    const [id] = await loadSettledCookbook();
    const db = await getLinkDishWebDb();

    const favoriteHeld = holdNextWrite(db, "transaction");
    const favoriting = setFavorite(id!, true);
    await favoriteHeld.started;
    const ratingHeld = holdNextWrite(db, "transaction");
    const rating = setRating(id!, 2);
    await ratingHeld.started;
    expect(getCachedSavedRecipe(id!)).toMatchObject({ favorite: true, rating: 2 });

    favoriteHeld.fail(new Error("disk full"));
    await expect(favoriting).rejects.toThrow("disk full");
    ratingHeld.fail(new Error("disk full"));
    await expect(rating).rejects.toThrow("disk full");

    // Rolling the rating back alone would show the favorite that never saved either.
    await waitFor(() => expect(getCachedSavedRecipe(id!)).not.toHaveProperty("favorite"));
    expect(getCachedSavedRecipe(id!)).not.toHaveProperty("rating");
  });

  const REMOTE_OPENED_AT = "2026-09-28T12:00:00.000Z";

  /**
   * Another tab opens recipe `id`; this tab starts re-reading just that recipe, and the read
   * comes back only once `release` is called (IndexedDB queues it behind a readwrite still
   * pending). `reread` resolves once this tab shows the other tab's change.
   */
  const startRemoteReread = async (id: string) => {
    const stored = fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, id);
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [{ ...stored!, lastOpenedAt: REMOTE_OPENED_AT }]);
    const queued = queueNextTransaction(await getLinkDishWebDb());
    act(() => {
      channel.onmessage?.({
        data: { topic: "savedRecipes", upsertedIds: [id], v: 1 }
      } as MessageEvent);
    });
    await queued.started;

    return {
      release: queued.release,
      reread: () =>
        waitFor(() => expect(getCachedSavedRecipe(id)?.lastOpenedAt).toBe(REMOTE_OPENED_AT))
    };
  };

  it("keeps a failed favorite rolled back when another tab's change is re-read meanwhile", async () => {
    const [failing, other] = await loadSettledCookbook();
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const favoriting = setFavorite(failing!, true);
    await held.started;
    expect(getCachedSavedRecipe(failing!)?.favorite).toBe(true);

    const reread = await startRemoteReread(other!);
    held.fail(new Error("disk full"));
    await expect(favoriting).rejects.toThrow("disk full");
    expect(getCachedSavedRecipe(failing!)).not.toHaveProperty("favorite");

    reread.release();
    await reread.reread();

    // Storage never got the favorite, so the re-read must not bring it back.
    expect(fakeIdb.record<WebSavedRecipe>(SAVED_RECIPES_STORE_NAME, failing!)).not.toHaveProperty(
      "favorite"
    );
    expect(getCachedSavedRecipe(failing!)).not.toHaveProperty("favorite");
  });

  it("keeps a recipe whose delete failed when another tab's change is re-read meanwhile", async () => {
    const [failing, other] = await loadSettledCookbook();
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const removing = removeSavedRecipe(failing!, { snapshot: false });
    await held.started;
    expect(getCachedSavedRecipe(failing!)).toBeUndefined();

    const reread = await startRemoteReread(other!);
    held.fail(new Error("disk full"));
    await expect(removing).rejects.toThrow("disk full");
    expect(getCachedSavedRecipe(failing!)).toBeDefined();

    reread.release();
    await reread.reread();

    // Still stored, so it must still be listed.
    expect(fakeIdb.record(SAVED_RECIPES_STORE_NAME, failing!)).toBeDefined();
    expect(getCachedSavedRecipe(failing!)).toBeDefined();
  });

  it("keeps a change made while another tab's change is re-read", async () => {
    const [changing, other] = await loadSettledCookbook();
    const reread = await startRemoteReread(other!);
    const held = holdNextWrite(await getLinkDishWebDb(), "transaction");

    const favoriting = setFavorite(changing!, true);
    await held.started;
    reread.release();
    await reread.reread();

    // The favorite is still being saved; the re-read of another recipe must not hide it.
    expect(getCachedSavedRecipe(changing!)?.favorite).toBe(true);
    held.fail(new Error("disk full"));
    await expect(favoriting).rejects.toThrow("disk full");
    expect(getCachedSavedRecipe(changing!)).not.toHaveProperty("favorite");
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

  it("keeps a recipe another tab deleted and put back within one batch", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const [first] = result.current.recipes;
    const restored = { ...first, lastOpenedAt: "2026-09-28T11:00:00.000Z" } as WebSavedRecipe;

    // Delete then Undo in the other tab land in the same debounce window; storage has it back.
    fakeIdb.seed(SAVED_RECIPES_STORE_NAME, [restored]);
    act(() => {
      channel.onmessage?.({
        data: { deletedIds: [first?.id], topic: "savedRecipes", v: 1 }
      } as MessageEvent);
      channel.onmessage?.({
        data: { topic: "savedRecipes", upsertedIds: [first?.id], v: 1 }
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(getCachedSavedRecipe(first?.id ?? "")?.lastOpenedAt).toBe("2026-09-28T11:00:00.000Z")
    );
    expect(result.current.recipes.map((recipe) => recipe.id)).toContain(first?.id);
  });

  it("drops a recipe another tab saved and then deleted within one batch", async () => {
    const { result } = renderHook(() => useSavedRecipes());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const [first] = result.current.recipes;
    const db = await (await import("../storage/linkdish-db")).getLinkDishWebDb();
    await db.delete(SAVED_RECIPES_STORE_NAME, first?.id ?? "");

    act(() => {
      channel.onmessage?.({
        data: { topic: "savedRecipes", upsertedIds: [first?.id], v: 1 }
      } as MessageEvent);
      channel.onmessage?.({
        data: { deletedIds: [first?.id], topic: "savedRecipes", v: 1 }
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(result.current.recipes.map((recipe) => recipe.id)).not.toContain(first?.id)
    );
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
