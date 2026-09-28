import { useEffect, useMemo, useRef, useState } from "react";

import { whenBootSettled } from "../../../platform/boot-settle";

import type * as SearchEngineModule from "./library-search-engine";
import type { Recipe, RecipeSearchFields, RecipeSearchIndex } from "@linkdish/recipe-domain";

export type SearchEngine = typeof SearchEngineModule;
/** What building an index needs (the engine chunk, or the same functions imported directly). */
export type SearchIndexBuilder = Pick<
  SearchEngine,
  "createRecipeSearchIndex" | "recipeSearchFields"
>;

let engine: SearchEngine | null = null;
let enginePromise: Promise<SearchEngine> | null = null;

/** Loads the search engine chunk once (resolves immediately after the first load). */
export const loadSearchEngine = (): Promise<SearchEngine> => {
  enginePromise ??= import("./library-search-engine").then(
    (module) => {
      engine = module;
      return module;
    },
    (error: unknown) => {
      enginePromise = null;
      throw error;
    }
  );

  return enginePromise;
};

/** Test seam: forget the loaded engine. */
export const resetSearchEngineForTests = (): void => {
  engine = null;
  enginePromise = null;
};

const IDLE_PRELOAD_DELAY_MS = 1200;

/**
 * The search engine, loaded right away when `needed`, otherwise once the page is idle so the
 * first keystroke is instant. `null` until it arrives.
 */
export function useSearchEngine(needed: boolean): SearchEngine | null {
  const [loaded, setLoaded] = useState<SearchEngine | null>(engine);

  useEffect(() => {
    if (loaded) {
      return;
    }

    let active = true;
    const load = () => {
      loadSearchEngine()
        .then((module) => {
          if (active) {
            setLoaded(module);
          }
        })
        .catch(() => undefined);
    };

    if (needed) {
      load();
      return () => {
        active = false;
      };
    }

    // Not needed for the first screen: a while after it has settled (platform/boot-settle.ts).
    let timer: number | undefined;
    const cancelSettled = whenBootSettled(() => {
      timer = window.setTimeout(load, IDLE_PRELOAD_DELAY_MS);
    });
    return () => {
      active = false;
      cancelSettled();
      window.clearTimeout(timer);
    };
  }, [loaded, needed]);

  return loaded;
}

export interface RecipeSearchIndexOptions<T> {
  getId: (record: T) => string;
  getFields: (engine: SearchIndexBuilder, record: T) => RecipeSearchFields;
  /**
   * Values that change whenever the searchable text of a record changes. Use strings built from
   * the text (see {@link recipeSearchKey}), not objects: a favorite or a cook log entry comes back
   * from IndexedDB as a new object with the same text, and must not rebuild the index.
   */
  getSignature: (record: T) => readonly unknown[];
  /** Changes when something outside the records feeds the index (e.g. collection names). */
  extraKey?: string | undefined;
  /**
   * Keeps the index at module scope under this name, so it survives remounts (Back from a recipe)
   * and is shared by every screen that asks with the same name and fields.
   */
  cacheKey?: string | undefined;
}

interface CachedIndex {
  signature: unknown[];
  index: RecipeSearchIndex<string>;
}

const sharedIndexes = new Map<string, CachedIndex>();

/** Test seam: forget the shared indexes. */
export const resetSearchIndexCacheForTests = (): void => {
  sharedIndexes.clear();
};

const recipeKeys = new WeakMap<Recipe, string>();
const SEPARATOR = "\u0001";

/**
 * The searchable text of a recipe as one string, cached per recipe object. Equal text gives an
 * equal key, so an unchanged recipe re-read from storage keeps the index.
 */
export const recipeSearchKey = (recipe: Recipe): string => {
  const cached = recipeKeys.get(recipe);

  if (cached !== undefined) {
    return cached;
  }

  const key = [
    recipe.title,
    recipe.sourceUrl,
    recipe.siteName ?? "",
    recipe.author ?? "",
    recipe.cuisine ?? "",
    recipe.category ?? "",
    ...(recipe.keywords ?? []),
    ...recipe.ingredients.map((ingredient) => ingredient.text),
    ...recipe.steps.map((step) => step.text)
  ].join(SEPARATOR);
  recipeKeys.set(recipe, key);
  return key;
};

const sameSignature = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  left.length === right.length && left.every((value, position) => value === right[position]);

/**
 * A search index over `records`, rebuilt only when the signature (ids plus searchable text)
 * changes. With `cacheKey` the index is kept at module scope for every caller using that name.
 */
export function getRecipeSearchIndex<T>(
  searchEngine: SearchIndexBuilder,
  records: readonly T[],
  byId: ReadonlyMap<string, T>,
  { getId, getFields, getSignature, extraKey = "", cacheKey }: RecipeSearchIndexOptions<T>,
  localCache?: { current: CachedIndex | null }
): RecipeSearchIndex<string> {
  const signature: unknown[] = [extraKey];

  for (const record of records) {
    signature.push(getId(record), ...getSignature(record));
  }

  const cached = cacheKey ? sharedIndexes.get(cacheKey) : localCache?.current;

  if (cached && sameSignature(cached.signature, signature)) {
    return cached.index;
  }

  const index = searchEngine.createRecipeSearchIndex(
    records.map((record) => getId(record)),
    (id) => {
      const record = byId.get(id);
      return record ? getFields(searchEngine, record) : {};
    }
  );
  const entry = { index, signature };

  if (cacheKey) {
    sharedIndexes.set(cacheKey, entry);
  } else if (localCache) {
    localCache.current = entry;
  }

  return index;
}

export interface LibrarySearch<T> {
  byId: Map<string, T>;
  /** Null until the engine has loaded (or while search is not needed yet). */
  index: RecipeSearchIndex<string> | null;
}

/**
 * A ranked search index over a list, rebuilt only when searchable content changes.
 *
 * The index stores ids, not records, so metadata edits that do not touch searchable text
 * (a favorite, a cook log entry) reuse it while results still resolve to the latest record. The
 * signature is built from text, not object identity, so a record re-read from storage with the
 * same text reuses it too; with `cacheKey` it also survives the page remounting.
 */
export function useRecipeSearchIndex<T>(
  searchEngine: SearchEngine | null,
  records: readonly T[],
  options: RecipeSearchIndexOptions<T>
): LibrarySearch<T> {
  const cacheRef = useRef<CachedIndex | null>(null);
  const { cacheKey, extraKey, getFields, getId, getSignature } = options;

  const byId = useMemo(
    () => new Map(records.map((record) => [getId(record), record])),
    [getId, records]
  );

  const index = useMemo(
    () =>
      searchEngine
        ? getRecipeSearchIndex(
            searchEngine,
            records,
            byId,
            { cacheKey, extraKey, getFields, getId, getSignature },
            cacheRef
          )
        : null,
    [byId, cacheKey, extraKey, getFields, getId, getSignature, records, searchEngine]
  );

  // One stable object per (byId, index): consumers memoize on it.
  return useMemo(() => ({ byId, index }), [byId, index]);
}

/**
 * Ranked ids for a query (every word must match), or — while the engine is still loading — a
 * plain case-insensitive title/ingredient match so typing never shows a blank page.
 */
export function searchRecords<T>(
  search: LibrarySearch<T>,
  query: string,
  getFallbackText: (record: T) => string,
  filter?: (record: T) => boolean
): T[] {
  const { byId, index } = search;

  if (index) {
    const idFilter = filter
      ? (id: string) => {
          const record = byId.get(id);
          return record ? filter(record) : false;
        }
      : undefined;

    return index
      .search(query, idFilter ? { filters: idFilter } : {})
      .flatMap((result) => byId.get(result.record) ?? []);
  }

  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);

  return [...byId.values()].filter((record) => {
    if (filter && !filter(record)) {
      return false;
    }

    const text = getFallbackText(record).toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
