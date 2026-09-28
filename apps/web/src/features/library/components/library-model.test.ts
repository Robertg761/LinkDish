import { describe, expect, it } from "vitest";

import {
  buildFilterChips,
  buildFilterPredicate,
  buildShelves,
  collectionFilterKey,
  countQuotaRecipes,
  FAVORITES_FILTER,
  formatCompactServings,
  formatRecipeMeta,
  getRecipeFacts,
  getTopTags,
  NOT_COOKED_FILTER,
  QUICK_FILTER,
  sortPersonalRecipes,
  tagFilterKey
} from "./library-model";

import type { WebCollection } from "../../../data/collections-store";
import type { WebSavedRecipe } from "../saved-recipe-types";
import type { Recipe } from "@linkdish/recipe-domain";

const recipe = (overrides: Partial<Recipe> = {}): Recipe =>
  ({
    cookTimeMinutes: null,
    image: null,
    ingredients: [{ text: "1 onion" }],
    nutrition: null,
    prepTimeMinutes: null,
    servings: null,
    sourceType: "recipe-webpage",
    sourceUrl: "https://www.seriouseats.com/soup",
    steps: [{ index: 1, text: "Cook." }],
    title: "Soup",
    ...overrides
  }) as Recipe;

const saved = (id: string, overrides: Partial<WebSavedRecipe> = {}, recipeOverrides = {}) =>
  ({
    createdAt: "2026-09-01T00:00:00.000Z",
    extraction: { fetchMode: "http", provenance: [], strategy: "recipe-schema", warnings: [] },
    id,
    recipe: recipe({ title: id, ...recipeOverrides }),
    sourceHost: "seriouseats.com",
    sourceUrl: "https://www.seriouseats.com/soup",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  }) as WebSavedRecipe;

describe("library-model", () => {
  it("formats card meta from the domain helpers, never the raw servings text", () => {
    expect(formatCompactServings("16, 1 loaf")).toBe("Serves 16");
    expect(formatCompactServings("36, 36 cookies")).toBe("36 cookies");
    expect(formatCompactServings("Serves 4-6")).toBe("Serves 4–6");
    expect(formatCompactServings("Varies")).toBe("Varies");
    expect(formatCompactServings("")).toBeNull();

    const bread = recipe({ cookTimeMinutes: 40, prepTimeMinutes: 12, servings: "16, 1 loaf" });
    expect(formatRecipeMeta(bread)).toBe("52 min · Serves 16");
    expect(formatRecipeMeta(bread, { includeSource: true })).toBe(
      "52 min · Serves 16 · seriouseats.com"
    );
    expect(getRecipeFacts(bread)).toMatchObject({ servingsArePeople: true, servingsShort: "16" });
    expect(getRecipeFacts(bread)).toBe(getRecipeFacts(bread));
  });

  it("sorts by every option, keeping the stored keys", () => {
    const recipes = [
      saved("Banana", { createdAt: "2026-09-03T00:00:00.000Z", rating: 3, timesCooked: 1 }),
      saved(
        "apple",
        { createdAt: "2026-09-01T00:00:00.000Z", lastCookedAt: "2026-09-10T00:00:00.000Z" },
        { cookTimeMinutes: 10 }
      ),
      saved("cherry", { createdAt: "2026-09-02T00:00:00.000Z", rating: 5, timesCooked: 4 })
    ];
    const ids = (sort: Parameters<typeof sortPersonalRecipes>[1], reverse = false) =>
      sortPersonalRecipes(recipes, sort, reverse ? "reverse" : "forward").map((entry) => entry.id);

    expect(ids("recent")).toEqual(["Banana", "cherry", "apple"]);
    expect(ids("recent", true)).toEqual(["apple", "cherry", "Banana"]);
    expect(ids("az")).toEqual(["apple", "Banana", "cherry"]);
    expect(ids("mostCooked")).toEqual(["cherry", "Banana", "apple"]);
    expect(ids("recentlyCooked")[0]).toBe("apple");
    expect(ids("quickest")[0]).toBe("apple");
    expect(ids("topRated")).toEqual(["cherry", "Banana", "apple"]);
  });

  it("combines filters with AND", () => {
    const recipes = [
      saved(
        "fav-quick",
        { collectionIds: ["c1"], favorite: true, tags: ["Weeknight"] },
        {
          cookTimeMinutes: 20
        }
      ),
      saved("fav-slow", { favorite: true, tags: ["weeknight"] }, { cookTimeMinutes: 90 }),
      saved("cooked", { timesCooked: 2 })
    ];
    const run = (keys: string[]) =>
      recipes.filter(buildFilterPredicate(keys) ?? (() => true)).map((entry) => entry.id);

    expect(buildFilterPredicate([])).toBeNull();
    expect(run([FAVORITES_FILTER])).toEqual(["fav-quick", "fav-slow"]);
    expect(run([FAVORITES_FILTER, QUICK_FILTER])).toEqual(["fav-quick"]);
    expect(run([NOT_COOKED_FILTER])).toEqual(["fav-quick", "fav-slow"]);
    expect(run([tagFilterKey("WEEKNIGHT")])).toEqual(["fav-quick", "fav-slow"]);
    expect(run([collectionFilterKey("c1"), tagFilterKey("weeknight")])).toEqual(["fav-quick"]);
  });

  it("builds chips with counts, collections and the tags used more than once", () => {
    const collections: WebCollection[] = [
      { createdAt: "", emoji: "🍲", id: "c1", name: "Dinners", sortOrder: 0, updatedAt: "" }
    ];
    const recipes = [
      saved("a", { collectionIds: ["c1"], favorite: true, tags: ["Soup", "Once"] }),
      saved("b", { tags: ["soup"] })
    ];

    expect(getTopTags(recipes).map((tag) => [tag.label, tag.count])).toEqual([
      ["Soup", 2],
      ["Once", 1]
    ]);
    expect(buildFilterChips(recipes, collections).map((chip) => [chip.label, chip.count])).toEqual([
      ["Favorites", 1],
      ["Quick", 0],
      ["Not cooked yet", 2],
      ["Dinners", 1],
      ["Soup", 2]
    ]);
  });

  it("counts quota recipes like the store (starters excluded)", () => {
    expect(countQuotaRecipes([saved("starter-soup"), saved("mine"), saved("other")])).toBe(2);
  });

  it("builds shelves only for a big enough cookbook and skips a duplicate of the grid order", () => {
    const small = [saved("a"), saved("b")];
    expect(buildShelves(small)).toEqual([]);

    const recipes = Array.from({ length: 6 }, (_, index) =>
      saved(`r${index}`, index < 2 ? { lastCookedAt: `2026-09-0${index + 1}T00:00:00.000Z` } : {}, {
        cookTimeMinutes: index * 10 + 5
      })
    );
    const shelves = buildShelves(recipes, "az");

    expect(shelves.map((shelf) => shelf.id)).toEqual(["cook-again", "quick", "recent"]);
    expect(shelves[0]?.recipes.map((entry) => entry.id)).toEqual(["r1", "r0"]);
    expect(buildShelves(recipes, "recent").map((shelf) => shelf.id)).toEqual([
      "cook-again",
      "quick"
    ]);
  });
});
