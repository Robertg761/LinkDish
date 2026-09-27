import { describe, expect, it } from "vitest";

import {
  createRecipeSearchIndex,
  foldSearchText,
  highlightRanges,
  recipeSearchFields,
  SAMPLE_RECIPES,
  tokenizeSearchText
} from "./index.js";

import type { Recipe, RecipeSearchFields } from "./index.js";

type Doc = { id: string; fields: RecipeSearchFields };

const docs: Doc[] = [
  {
    id: "soup",
    fields: {
      title: "Soup",
      ingredients: ["1 onion"],
      steps: ["Cook."],
      source: "example.com",
      notes: "Great with lemon."
    }
  },
  {
    id: "pasta",
    fields: {
      title: "Pasta",
      ingredients: ["Tomatoes"],
      steps: ["Simmer sauce."],
      source: "example.com"
    }
  },
  {
    id: "brulee",
    fields: {
      title: "Crème Brûlée",
      tags: ["dessert", "french"],
      ingredients: ["2 cups heavy cream", "5 egg yolks", "1/2 cup sugar"],
      steps: ["Bake in a water bath."],
      source: "bonappetit.com"
    }
  },
  {
    id: "chicken-rice",
    fields: {
      title: "Chicken Rice Skillet",
      tags: ["dinner"],
      ingredients: ["1 lb chicken thighs", "3 cups cooked rice", "2 scallions"],
      steps: ["Brown the chicken.", "Stir in the rice."],
      source: "linkdish.ca"
    }
  },
  {
    id: "rice-pudding",
    fields: {
      title: "Rice Pudding",
      tags: ["dessert"],
      ingredients: ["1 cup rice", "4 cups milk", "cinnamon"],
      steps: ["Simmer until creamy. Serve with chicken? Never."],
      source: "example.org"
    }
  }
];

const index = createRecipeSearchIndex(docs, (doc) => doc.fields);
const ids = (query: string) => index.search(query).map((result) => result.record.id);

describe("createRecipeSearchIndex", () => {
  it("keeps the mobile library semantics", () => {
    expect(ids("lemon")).toEqual(["soup"]);
    expect(ids("tomatoes simmer")).toEqual(["pasta"]);
    expect(ids("example").slice(0, 2)).toEqual(["soup", "pasta"]);
  });

  it("returns every record in order for an empty query", () => {
    expect(ids("")).toEqual(docs.map((doc) => doc.id));
    expect(ids("   ")).toEqual(docs.map((doc) => doc.id));
    expect(index.size).toBe(5);
  });

  it("requires every word to match", () => {
    expect(ids("rice dessert")).toEqual(["rice-pudding"]);
    expect(ids("rice chicken")).toEqual(["chicken-rice", "rice-pudding"]);
    expect(ids("rice lasagna")).toEqual([]);
  });

  it("folds diacritics and case, and singularizes", () => {
    expect(ids("creme brulee")).toEqual(["brulee"]);
    expect(ids("CRÈME")).toEqual(["brulee"]);
    expect(ids("tomato")).toEqual(["pasta"]);
    expect(ids("yolk")).toEqual(["brulee"]);
    expect(ids("onions")).toEqual(["soup"]);
  });

  it("matches the word being typed as a prefix", () => {
    expect(ids("chick")).toEqual(["chicken-rice", "rice-pudding"]);
    expect(ids("brû")).toEqual(["brulee"]);
    // A finished word still falls back to a weaker prefix match, so "chick rice" works.
    expect(ids("chick rice")).toEqual(["chicken-rice", "rice-pudding"]);
    expect(index.search("chick ")[0]?.score ?? 0).toBeLessThan(
      index.search("chick")[0]?.score ?? 0
    );
    expect(ids("ch ")).toEqual([]);
  });

  it("ranks by field boost: title > tags > ingredients > source/notes > steps", () => {
    const results = index.search("chicken");

    expect(results.map((result) => result.record.id)).toEqual(["chicken-rice", "rice-pudding"]);
    expect(results[0]).toMatchObject({ score: 5, matches: ["title", "ingredients", "steps"] });
    expect(results[1]).toMatchObject({ score: 1, matches: ["steps"] });
    expect(index.search("dessert")[0]?.matches).toEqual(["tags"]);
  });

  it("breaks ties by original order and boosts title phrases", () => {
    expect(ids("dessert")).toEqual(["brulee", "rice-pudding"]);
    expect(index.search("chicken rice")[0]?.score).toBeGreaterThan(10);
  });

  it("ignores stopwords unless the query is only stopwords", () => {
    expect(ids("the rice and chicken")).toEqual(["chicken-rice", "rice-pudding"]);
    expect(ids("in")).toEqual(["brulee", "chicken-rice"]);
  });

  it("applies filters and limits", () => {
    const desserts = (doc: Doc) =>
      Array.isArray(doc.fields.tags) && (doc.fields.tags as string[]).includes("dessert");

    expect(index.search("rice", { filters: desserts }).map((result) => result.record.id)).toEqual([
      "rice-pudding"
    ]);
    expect(
      index.search("", { filters: [desserts], limit: 1 }).map((result) => result.record.id)
    ).toEqual(["brulee"]);
    expect(index.search("rice", { limit: 1 })).toHaveLength(1);
  });
});

describe("recipeSearchFields", () => {
  it("indexes a recipe's title, tags, ingredients, source and steps", () => {
    const recipes = SAMPLE_RECIPES.map((sample) => sample.recipe as Recipe);
    const recipeIndex = createRecipeSearchIndex(recipes, (recipe) =>
      recipeSearchFields(recipe, {
        notes: recipe.title.includes("Pitas") ? "Lunchbox favorite" : null
      })
    );

    expect(recipeIndex.search("sesame")[0]?.record.title).toBe(
      "Ginger-Sesame Chicken Rice Skillet"
    );
    expect(recipeIndex.search("berries")[0]?.record.title).toBe("Brown Butter Berry Oat Bars");
    expect(recipeIndex.search("lunchbox")[0]?.record.title).toBe("Crisp Cucumber Chickpea Pitas");
    expect(recipeIndex.search("linkdish.ca")).toHaveLength(3);
  });
});

describe("tokenizing and highlighting", () => {
  it("folds and tokenizes", () => {
    expect(foldSearchText("Crème Brûlée")).toBe("creme brulee");
    expect(tokenizeSearchText("Jalapeño-Lime Tacos!")).toEqual(["jalapeno", "lime", "taco"]);
  });

  it("returns merged highlight ranges in the original text", () => {
    expect(highlightRanges("Chicken Rice Skillet", "chick")).toEqual([{ start: 0, end: 5 }]);
    expect(highlightRanges("Crème Brûlée", "creme")).toEqual([{ start: 0, end: 5 }]);
    expect(highlightRanges("Two Tomatoes and a tomato", "tomato")).toEqual([
      { start: 4, end: 12 },
      { start: 19, end: 25 }
    ]);
    expect(highlightRanges("Rice Pudding", "rice pud")).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 8 }
    ]);
    expect(highlightRanges("Soup", "")).toEqual([]);
  });
});

describe("search performance", () => {
  // Deterministic pseudo-random library so the benchmark is stable between runs.
  const createRandom = (seed: number) => {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  };
  const vocabulary = [
    "chicken",
    "beef",
    "tofu",
    "salmon",
    "rice",
    "pasta",
    "lemon",
    "garlic",
    "ginger",
    "tomato",
    "basil",
    "coconut",
    "curry",
    "noodles",
    "spinach",
    "mushroom",
    "potato",
    "onion",
    "butter",
    "cream",
    "honey",
    "sesame",
    "chili",
    "lime",
    "cilantro",
    "black beans",
    "chickpeas",
    "yogurt",
    "feta",
    "oats"
  ];

  it("queries 1,000 recipes well under 15 ms", () => {
    const random = createRandom(42);
    const pick = () => vocabulary[Math.floor(random() * vocabulary.length)] ?? "rice";
    const library = Array.from({ length: 1_000 }, (_unused, recipeIndex) => ({
      id: recipeIndex,
      fields: {
        title: `${pick()} ${pick()} bowl ${recipeIndex}`,
        tags: [pick(), "weeknight"],
        ingredients: Array.from({ length: 12 }, () => `1 cup ${pick()}, chopped`),
        source: `site${recipeIndex % 40}.com`,
        notes: `Family favorite with extra ${pick()}`,
        steps: Array.from(
          { length: 8 },
          () => `Cook the ${pick()} with the ${pick()} until golden, about 5 minutes.`
        )
      }
    }));
    const libraryIndex = createRecipeSearchIndex(library, (entry) => entry.fields);
    const queries = [
      "chicken",
      "chick",
      "lemon garlic",
      "c",
      "coconut curry rice",
      "zzz",
      "golden"
    ];

    // Warm up the JIT before timing.
    for (const query of queries) {
      libraryIndex.search(query);
    }

    // The median of several runs keeps a GC pause or a busy test worker from failing the run.
    const median = (values: number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    for (const query of queries) {
      const timings = Array.from({ length: 7 }, () => {
        const start = performance.now();
        libraryIndex.search(query);
        return performance.now() - start;
      });
      const elapsed = median(timings);

      expect(elapsed, `${query}: median ${elapsed.toFixed(2)} ms`).toBeLessThan(15);
    }
  });
});
