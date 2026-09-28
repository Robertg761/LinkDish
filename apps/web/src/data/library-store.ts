import { useCallback, useMemo } from "react";

import { trackWebEvent } from "../analytics/client";
import {
  deleteSavedRecipe,
  duplicateSavedRecipe,
  getSavedRecipeById,
  loadCookbookRecipes,
  logRecipeCooked,
  markRecipeOpened,
  normalizeRecipeTags,
  setRecipeCollectionMembership,
  setRecipeCollections,
  setRecipeFavorite,
  setRecipePreferredServings,
  setRecipeRating,
  setRecipeTags,
  toSavedRecipeListRecord,
  updateRecipeNotes,
  type RecipeTagsUpdate,
  type SavedRecipeQuotaOptions
} from "../features/library/saved-recipe-store";

import { isDeepEqual, reconcileById } from "./reconcile";
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

const getRecipeId = (recipe: WebSavedRecipe) => recipe.id;

/**
 * A re-read record, reusing the cached one when nothing changed, or at least its `recipe` when
 * only personal metadata did (a favorite, a rating, "opened"). The recipe object is what card
 * memos, the per-recipe facts cache and the search index key on.
 */
const reconcileRecipe = (previous: WebSavedRecipe, next: WebSavedRecipe): WebSavedRecipe => {
  if (previous.recipe === next.recipe || !isDeepEqual(previous.recipe, next.recipe)) {
    return isDeepEqual(previous, next) ? previous : next;
  }

  const merged = { ...next, recipe: previous.recipe };
  return isDeepEqual(previous, merged) ? previous : merged;
};

const applyUpserts = (
  current: WebSavedRecipe[],
  upserted: readonly WebSavedRecipe[] | undefined,
  deletedIds: readonly string[] | undefined
): WebSavedRecipe[] => {
  const currentById = new Map(current.map((recipe) => [recipe.id, recipe]));
  const records = upserted?.map((record) => {
    const before = currentById.get(record.id);
    return before ? reconcileRecipe(before, record) : record;
  });
  const changed =
    Boolean(deletedIds?.some((id) => currentById.has(id))) ||
    Boolean(records?.some((record) => currentById.get(record.id) !== record));

  if (!changed) {
    return current;
  }

  const next = upsertById(current, records, deletedIds, getRecipeId);
  return next === current ? current : sortSavedRecipes(next);
};

const applySavedRecipeChange = (current: WebSavedRecipe[], change: DataChange): WebSavedRecipe[] =>
  applyUpserts(
    current,
    (change.upserted as WebSavedRecipe[] | undefined)?.map(toSavedRecipeListRecord),
    change.deletedIds
  );

/** Another tab wrote these recipes: re-read just them (a missing one was deleted). */
const applyRemoteSavedRecipeChanges = async (
  current: WebSavedRecipe[],
  changes: readonly DataChange[]
): Promise<WebSavedRecipe[]> => {
  const deleted = new Set(changes.flatMap((change) => change.deletedIds ?? []));
  const ids = [...new Set(changes.flatMap((change) => change.upsertedIds ?? []))].filter(
    (id) => !deleted.has(id)
  );
  const upserted: WebSavedRecipe[] = [];

  for (const id of ids) {
    const record = await getSavedRecipeById(id);

    if (record) {
      upserted.push(toSavedRecipeListRecord(record));
    } else {
      deleted.add(id);
    }
  }

  return applyUpserts(current, upserted, [...deleted]);
};

const libraryResource = createResourceStore<WebSavedRecipe[]>({
  applyLocalChange: applySavedRecipeChange,
  applyRemoteChanges: applyRemoteSavedRecipeChanges,
  initial: [],
  load: loadCookbookRecipes,
  reconcile: (previous, next) => reconcileById(previous, next, getRecipeId, reconcileRecipe),
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

/** Reports a personal-metadata change once it is saved (a failed save reports nothing). */
const reportWhenSaved = <Result>(
  saving: Promise<Result>,
  eventName: "recipe_favorited" | "recipe_rated" | "recipe_tagged",
  properties: Record<string, number | boolean | null>
): Promise<Result> =>
  saving.then((result) => {
    trackWebEvent({ eventName, properties, routeOrScreen: window.location.pathname });
    return result;
  });

export const setFavorite = (id: string, favorite: boolean) =>
  reportWhenSaved(
    optimistic(
      id,
      (recipe) => setOrDelete(recipe, "favorite", favorite ? true : undefined),
      () => setRecipeFavorite(id, favorite)
    ),
    "recipe_favorited",
    { favorited: favorite }
  );

export const toggleFavorite = (id: string) => setFavorite(id, !getCachedSavedRecipe(id)?.favorite);

/**
 * Sets a recipe's tags. Editors that add or remove a tag pass a function of the current tags:
 * it runs on the tags as stored when the write happens, so a tag another tab added meanwhile
 * (this tab may not have heard of it yet) is kept.
 */
export const setTags = (id: string, tags: RecipeTagsUpdate) => {
  const nextTags = (current: readonly string[]) =>
    normalizeRecipeTags(typeof tags === "function" ? tags(current) : tags);
  const cached = getCachedSavedRecipe(id);
  const tagCount = nextTags(cached?.tags ?? []).length;

  return reportWhenSaved(
    optimistic(
      id,
      (recipe) => {
        const next = nextTags(recipe.tags ?? []);
        return setOrDelete(recipe, "tags", next.length ? next : undefined);
      },
      () => setRecipeTags(id, nextTags)
    ),
    "recipe_tagged",
    { tag_count: tagCount }
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

/** Adds to or removes from the recipe's collections as stored (not as this tab last saw them). */
const setMembership = (id: string, collectionId: string, member: boolean) =>
  optimistic(
    id,
    (recipe) => {
      const current = recipe.collectionIds ?? [];
      const next = member
        ? Array.from(new Set([...current, collectionId]))
        : current.filter((entry) => entry !== collectionId);
      return setOrDelete(recipe, "collectionIds", next.length ? next : undefined);
    },
    () => setRecipeCollectionMembership(id, collectionId, member)
  );

export const addToCollection = (id: string, collectionId: string) =>
  setMembership(id, collectionId, true);

export const removeFromCollection = (id: string, collectionId: string) =>
  setMembership(id, collectionId, false);

export const setRating = (id: string, rating: RecipeRating | null) =>
  reportWhenSaved(
    optimistic(
      id,
      (recipe) => setOrDelete(recipe, "rating", rating ?? undefined),
      () => setRecipeRating(id, rating)
    ),
    "recipe_rated",
    { rating }
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

/**
 * Deletes the local recipe (the household copy, if any, is the caller's job). Resolves with the
 * recipe as it was deleted, scans included, for Undo (`undefined` when it was already gone).
 */
export async function removeSavedRecipe(id: string): Promise<WebSavedRecipe | undefined> {
  const previous = libraryResource.getSnapshot().data;
  libraryResource.update((current) => current.filter((recipe) => recipe.id !== id));

  try {
    return await deleteSavedRecipe(id);
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
