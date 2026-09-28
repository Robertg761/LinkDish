import { createRecipeSearchIndex, recipeSearchFields } from "@linkdish/recipe-domain";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRecipeSearchIndex,
  recipeSearchKey,
  resetSearchIndexCacheForTests,
  useRecipeSearchIndex
} from "./use-library-search";

import type { RecipeSearchIndexOptions, SearchEngine } from "./use-library-search";
import type { Recipe } from "@linkdish/recipe-domain";

interface Row {
  id: string;
  favorite?: boolean;
  recipe: Recipe;
}

const recipe = (title: string, ingredient = "1 onion"): Recipe =>
  ({
    image: null,
    ingredients: [{ text: ingredient }],
    sourceUrl: `https://example.com/${title}`,
    steps: [{ index: 1, text: "Cook it." }],
    title
  }) as unknown as Recipe;

/** A structured clone, like every record IndexedDB hands back. */
const clone = <T>(value: T): T => structuredClone(value);

const build = vi.fn(createRecipeSearchIndex);
const engine = {
  createRecipeSearchIndex: build,
  highlightRanges: () => [],
  recipeSearchFields
} as unknown as SearchEngine;

const options: RecipeSearchIndexOptions<Row> = {
  cacheKey: "test",
  getFields: (searchEngine, row) => searchEngine.recipeSearchFields(row.recipe),
  getId: (row) => row.id,
  getSignature: (row) => [recipeSearchKey(row.recipe)]
};

describe("recipe search index cache", () => {
  beforeEach(() => {
    build.mockClear();
    resetSearchIndexCacheForTests();
  });

  it("keeps the index for re-read records with the same text, and rebuilds when text changes", () => {
    const rows: Row[] = [
      { id: "soup", recipe: recipe("Tomato Soup") },
      { id: "pie", recipe: recipe("Apple Pie", "6 apples") }
    ];
    const byId = (list: Row[]) => new Map(list.map((row) => [row.id, row]));
    const first = getRecipeSearchIndex(engine, rows, byId(rows), options);

    // A favorite comes back from storage as a clone: new objects, same text.
    const favorited = rows.map((row) => ({ ...clone(row), favorite: true }));
    expect(getRecipeSearchIndex(engine, favorited, byId(favorited), options)).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);

    const edited = [
      { ...rows[0], recipe: recipe("Tomato Soup", "2 leeks") } as Row,
      rows[1] as Row
    ];
    const second = getRecipeSearchIndex(engine, edited, byId(edited), options);
    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    expect(second.search("leeks").map((result) => result.record)).toEqual(["soup"]);
  });

  it("survives a remount and returns one stable object per index", () => {
    const rows: Row[] = [{ id: "soup", recipe: recipe("Tomato Soup") }];
    const first = renderHook(() => useRecipeSearchIndex(engine, rows, options));
    const search = first.result.current;
    first.rerender();
    expect(first.result.current).toBe(search);
    first.unmount();

    // Back from a recipe: the Cookbook mounts again and reuses the module-level index.
    const second = renderHook(() => useRecipeSearchIndex(engine, rows, options));
    expect(second.result.current.index).toBe(search.index);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
