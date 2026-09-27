import { useCallback, useMemo } from "react";

import {
  deleteSavedRecipe,
  duplicateSavedRecipe,
  getSavedRecipes,
  logRecipeCooked,
  markRecipeOpened,
  normalizeRecipeTags,
  seedStarterRecipesIfNeeded,
  setRecipeCollections,
  setRecipeFavorite,
  setRecipePreferredServings,
  setRecipeRating,
  setRecipeTags,
  toSavedRecipeListRecord,
  updateRecipeNotes,
  type SavedRecipeQuotaOptions
} from "../features/library/saved-recipe-store";

import { createResourceStore, toViewStatus, upsertById, useResource } from "./resource-store";

import type { DataChange } from "./change-feed";
import type {
  RecipeCookLogEntry,
  RecipeRating,
  WebSavedRecipe,
  WebSavedRecipeMetadataKey
} from "../features/library/saved-recipe-types";

/**
 * The cookbook as a reactive, in-memory cache of saved recipes (list records, no source images).
 * Loaded once per page session (starter seeding preserved), kept fresh by same-tab write events
 * and cross-tab BroadcastChannel refreshes, with optimistic metadata mutations.
 */

const timestampOf = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

/** Newest update first — the order `getSavedRecipes()` has always returned. */
export const sortSavedRecipes = (recipes: readonly WebSavedRecipe[]): WebSavedRecipe[] =>
  recipes
    .map((recipe) => ({ recipe, time: timestampOf(recipe.updatedAt) }))
    .sort((a, b) => b.time - a.time)
    .map((entry) => entry.recipe);

const applySavedRecipeChange = (
  current: WebSavedRecipe[],
  change: DataChange
): WebSavedRecipe[] => {
  const upserted = (change.upserted as WebSavedRecipe[] | undefined)?.map(toSavedRecipeListRecord);
  const next = upsertById(current, upserted, change.deletedIds, (recipe) => recipe.id);
  return next === current ? current : sortSavedRecipes(next);
};

const libraryResource = createResourceStore<WebSavedRecipe[]>({
  applyLocalChange: applySavedRecipeChange,
  initial: [],
  async load() {
    await seedStarterRecipesIfNeeded();
    return getSavedRecipes();
  },
  topic: "savedRecipes"
});

export interface SavedRecipesView {
  error: unknown;
  recipes: WebSavedRecipe[];
  retry: () => void;
  status: "loading" | "ready" | "error";
}

/** The cookbook, loading it on first use. `retry` re-reads after an error. */
export function useSavedRecipes(): SavedRecipesView {
  const snapshot = useResource(libraryResource);
  const retry = useCallback(() => {
    void libraryResource.load({ force: true });
  }, []);

  return useMemo(
    () => ({
      error: snapshot.error,
      recipes: snapshot.data,
      retry,
      status: toViewStatus(snapshot.status)
    }),
    [retry, snapshot]
  );
}

/** One cached cookbook entry (list record, no source images) plus the cookbook load status. */
export function useSavedRecipe(id: string | undefined): {
  recipe: WebSavedRecipe | undefined;
  status: "loading" | "ready" | "error";
} {
  const { recipes, status } = useSavedRecipes();
  const recipe = useMemo(
    () => (id ? recipes.find((entry) => entry.id === id) : undefined),
    [id, recipes]
  );

  return { recipe, status };
}

/** Loads the cookbook if needed (never rejects; check the snapshot for errors). */
export const loadSavedRecipes = (options?: { force?: boolean }): Promise<void> =>
  libraryResource.load(options);

export const refreshSavedRecipes = (): Promise<void> => libraryResource.load({ force: true });

export const getSavedRecipesSnapshot = () => libraryResource.getSnapshot();

export const subscribeSavedRecipes = (listener: () => void): (() => void) =>
  libraryResource.subscribe(listener);

export const getCachedSavedRecipe = (id: string): WebSavedRecipe | undefined =>
  libraryResource.getSnapshot().data.find((recipe) => recipe.id === id);

/* ------------------------------------------------------------------------------------------------
 * Optimistic mutations
 * ---------------------------------------------------------------------------------------------- */

const replaceCached = (recipe: WebSavedRecipe) => {
  libraryResource.update((current) =>
    current.map((entry) => (entry.id === recipe.id ? recipe : entry))
  );
};

/**
 * Applies `patch` to the cached recipe immediately, persists with `commit`, and rolls the cache
 * back (rethrowing) when persisting fails.
 */
async function optimistic<Result>(
  id: string,
  patch: (recipe: WebSavedRecipe) => WebSavedRecipe,
  commit: () => Promise<Result>
): Promise<Result> {
  const previous = getCachedSavedRecipe(id);

  if (previous) {
    replaceCached(patch(previous));
  }

  try {
    return await commit();
  } catch (error) {
    if (previous) {
      replaceCached(previous);
    }

    throw error;
  }
}

const setOrDelete = <Key extends WebSavedRecipeMetadataKey | "notes">(
  recipe: WebSavedRecipe,
  key: Key,
  value: WebSavedRecipe[Key] | undefined
): WebSavedRecipe => {
  const next = { ...recipe };

  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }

  return next;
};

export const setFavorite = (id: string, favorite: boolean) =>
  optimistic(
    id,
    (recipe) => setOrDelete(recipe, "favorite", favorite ? true : undefined),
    () => setRecipeFavorite(id, favorite)
  );

export const toggleFavorite = (id: string) => setFavorite(id, !getCachedSavedRecipe(id)?.favorite);

export const setTags = (id: string, tags: readonly string[]) => {
  const normalized = normalizeRecipeTags(tags);
  return optimistic(
    id,
    (recipe) => setOrDelete(recipe, "tags", normalized.length ? normalized : undefined),
    () => setRecipeTags(id, normalized)
  );
};

export const setCollections = (id: string, collectionIds: readonly string[]) => {
  const unique = Array.from(new Set(collectionIds));
  return optimistic(
    id,
    (recipe) => setOrDelete(recipe, "collectionIds", unique.length ? unique : undefined),
    () => setRecipeCollections(id, unique)
  );
};

export const addToCollection = (id: string, collectionId: string) =>
  setCollections(id, [...(getCachedSavedRecipe(id)?.collectionIds ?? []), collectionId]);

export const removeFromCollection = (id: string, collectionId: string) =>
  setCollections(
    id,
    (getCachedSavedRecipe(id)?.collectionIds ?? []).filter((entry) => entry !== collectionId)
  );

export const setRating = (id: string, rating: RecipeRating | null) =>
  optimistic(
    id,
    (recipe) => setOrDelete(recipe, "rating", rating ?? undefined),
    () => setRecipeRating(id, rating)
  );

export const setPreferredServings = (id: string, servings: number | null) =>
  optimistic(
    id,
    (recipe) =>
      setOrDelete(recipe, "preferredServings", servings && servings > 0 ? servings : undefined),
    () => setRecipePreferredServings(id, servings)
  );

export const logCooked = (id: string, entry: Partial<RecipeCookLogEntry> = {}) => {
  const cookedAt = entry.cookedAt ?? new Date().toISOString();
  return optimistic(
    id,
    (recipe) => ({
      ...recipe,
      cookLog: [
        ...(recipe.cookLog ?? []),
        { cookedAt, ...(entry.note ? { note: entry.note } : {}) }
      ],
      lastCookedAt: cookedAt,
      timesCooked: (recipe.timesCooked ?? 0) + 1
    }),
    () => logRecipeCooked(id, { ...entry, cookedAt })
  );
};

export const markOpened = (id: string) => {
  const openedAt = new Date().toISOString();
  return optimistic(
    id,
    (recipe) => ({ ...recipe, lastOpenedAt: openedAt }),
    () => markRecipeOpened(id, openedAt)
  );
};

export const updateNotes = (id: string, notes: string | null) =>
  optimistic(
    id,
    (recipe) => setOrDelete(recipe, "notes", notes?.trim() || undefined),
    () => updateRecipeNotes(id, notes)
  );

/** Deletes the local recipe (the household copy, if any, is the caller's job). */
export async function removeSavedRecipe(id: string): Promise<void> {
  const previous = libraryResource.getSnapshot().data;
  libraryResource.update((current) => current.filter((recipe) => recipe.id !== id));

  try {
    await deleteSavedRecipe(id);
  } catch (error) {
    libraryResource.update(() => previous);
    throw error;
  }
}

/** Duplicates a recipe (throws `SavedRecipeLimitError` for full free cookbooks). */
export const duplicateRecipe = (id: string, options?: SavedRecipeQuotaOptions) =>
  duplicateSavedRecipe(id, options);

/** Test seam: forgets the cache so the next use reloads from storage. */
export function resetLibraryStoreForTests(): void {
  libraryResource.reset();
}
