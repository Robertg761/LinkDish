import { useEffect, useMemo, useRef, useState } from "react";

import type * as SearchEngineModule from "./library-search-engine";
import type { RecipeSearchFields, RecipeSearchIndex } from "@linkdish/recipe-domain";

export type SearchEngine = typeof SearchEngineModule;

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

    const timer = window.setTimeout(load, IDLE_PRELOAD_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loaded, needed]);

  return loaded;
}

export interface RecipeSearchIndexOptions<T> {
  getId: (record: T) => string;
  getFields: (engine: SearchEngine, record: T) => RecipeSearchFields;
  /** Values that change whenever the searchable text of a record changes (compared by identity). */
  getSignature: (record: T) => readonly unknown[];
  /** Changes when something outside the records feeds the index (e.g. collection names). */
  extraKey?: string | undefined;
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
 * (a favorite, a cook log entry) reuse it while results still resolve to the latest record.
 */
export function useRecipeSearchIndex<T>(
  searchEngine: SearchEngine | null,
  records: readonly T[],
  { getId, getFields, getSignature, extraKey = "" }: RecipeSearchIndexOptions<T>
): LibrarySearch<T> {
  const cacheRef = useRef<{ signature: unknown[]; index: RecipeSearchIndex<string> } | null>(null);

  const byId = useMemo(
    () => new Map(records.map((record) => [getId(record), record])),
    [getId, records]
  );

  const index = useMemo(() => {
    if (!searchEngine) {
      return null;
    }

    const signature: unknown[] = [extraKey];

    for (const record of records) {
      signature.push(getId(record), ...getSignature(record));
    }

    const cached = cacheRef.current;

    if (
      cached &&
      cached.signature.length === signature.length &&
      cached.signature.every((value, position) => value === signature[position])
    ) {
      return cached.index;
    }

    const next = searchEngine.createRecipeSearchIndex(
      records.map((record) => getId(record)),
      (id) => {
        const record = byId.get(id);
        return record ? getFields(searchEngine, record) : {};
      }
    );
    cacheRef.current = { index: next, signature };
    return next;
  }, [byId, extraKey, getFields, getId, getSignature, records, searchEngine]);

  return { byId, index };
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
