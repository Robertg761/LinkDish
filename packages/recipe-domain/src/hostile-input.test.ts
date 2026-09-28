import { describe, expect, it } from "vitest";

import {
  canonicalIngredientKey,
  cleanShoppingItemName,
  normalizeFractionSlashes,
  paprikaRecipeToRecipe,
  parseIngredientQuantity,
  parseServings,
  parseStepDurations
} from "./index.js";

/*
 * Regressions for the CodeQL polynomial-ReDoS alerts: each input below took 0.5–4 s at
 * 40,000–100,000 characters before the fix (a regex retried at every position of a long run) and
 * takes about a millisecond after it. The 50 ms bound is generous on purpose; quadratic work on
 * these inputs is thousands of times slower, so the check cannot pass by luck.
 */
const HOSTILE = 100_000;
const MAX_MILLISECONDS = 50;

/** Fastest of three runs: a GC pause cannot fail the check, and quadratic work never is fast. */
const fastestMilliseconds = (run: () => unknown): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      run();
      return performance.now() - started;
    })
  );

describe("servings on hostile input", () => {
  it("drops parentheticals in linear time, even with a long run of unclosed '('", () => {
    const text = `4 ${"(".repeat(HOSTILE)}x`;

    expect(parseServings(text)?.min).toBe(4);
    expect(fastestMilliseconds(() => parseServings(text))).toBeLessThan(MAX_MILLISECONDS);
  });

  it("trims trailing punctuation in linear time when a long run is not at the end", () => {
    const text = `4 cookies${".".repeat(HOSTILE)}x`;

    expect(parseServings(text)?.kind).toBe("items");
    expect(fastestMilliseconds(() => parseServings(text))).toBeLessThan(MAX_MILLISECONDS);
    expect(parseServings(`12 cookies${" .".repeat(HOSTILE)}`)?.display).toBe("12 cookies");
  });

  it("splits segments on long whitespace runs in linear time", () => {
    const text = `16${" ".repeat(HOSTILE)},${"\t".repeat(HOSTILE)}1 loaf${" ".repeat(HOSTILE)}x`;

    expect(parseServings(`16${" ".repeat(HOSTILE)},${"\t".repeat(HOSTILE)}1 loaf`)?.display).toBe(
      "Serves 16 · 1 loaf"
    );
    expect(fastestMilliseconds(() => parseServings(text))).toBeLessThan(MAX_MILLISECONDS);
  });

  it("still splits the separators it always did, whatever the spacing", () => {
    expect(parseServings("16 , 1 loaf")?.display).toBe("Serves 16 · 1 loaf");
    expect(parseServings("16;1 loaf")?.display).toBe("Serves 16 · 1 loaf");
    expect(parseServings("4 quarts  ;  10-14 serving(s)")?.display).toBe("Serves 10–14 · 4 quarts");
    expect(parseServings("4 servings / 1 loaf")?.display).toBe("Serves 4 · 1 loaf");
    expect(parseServings("36 (about) , 36 cookies (small)")?.display).toBe("36 cookies");
  });
});

describe("number phrases on hostile input", () => {
  const spaced = `1${" ".repeat(HOSTILE)}x⁄2`;

  it("normalizes fraction slashes in linear time next to long whitespace runs", () => {
    expect(normalizeFractionSlashes(spaced)).toBe("1 x/2".replace(" ", " ".repeat(HOSTILE)));
    expect(fastestMilliseconds(() => normalizeFractionSlashes(spaced))).toBeLessThan(
      MAX_MILLISECONDS
    );
    expect(fastestMilliseconds(() => parseIngredientQuantity(`${spaced} cup`))).toBeLessThan(
      MAX_MILLISECONDS
    );
    expect(fastestMilliseconds(() => parseStepDurations(`${spaced} min`))).toBeLessThan(
      MAX_MILLISECONDS
    );
  });

  it("drops only the whitespace around each fraction slash, as before", () => {
    expect(normalizeFractionSlashes("1 ⁄ 2 cup")).toBe("1/2 cup");
    expect(normalizeFractionSlashes("1∕ 4 tsp")).toBe("1/4 tsp");
    expect(normalizeFractionSlashes(" ⁄ ⁄ 2 ")).toBe("//2 ");
    expect(normalizeFractionSlashes("a ⁄\n\tb ⁄ c")).toBe("a/b/c");
    expect(normalizeFractionSlashes("no slash  here ")).toBe("no slash  here ");
  });

  it("reads spaced and glued fractions after a whole number, as before", () => {
    expect(parseIngredientQuantity("1 ½ cups flour").qty).toBe(1.5);
    expect(parseIngredientQuantity("1½ cups flour").qty).toBe(1.5);
    expect(parseIngredientQuantity("1  1/2 cups flour").qty).toBe(1.5);
    expect(parseIngredientQuantity("1 ⁄ 2 cup milk").qty).toBe(0.5);
    expect(parseStepDurations("Bake 1 ½ hours").map((duration) => duration.minSeconds)).toEqual([
      5400
    ]);
  });
});

describe("shopping names on hostile input", () => {
  const inputs = [
    `a${" ".repeat(HOSTILE)}x`,
    `${"(".repeat(HOSTILE)}x`,
    `${"[".repeat(HOSTILE)}x`,
    `water${"*".repeat(HOSTILE)}x`
  ];

  it("cleans names in linear time", () => {
    for (const input of inputs) {
      expect(fastestMilliseconds(() => cleanShoppingItemName(input))).toBeLessThan(
        MAX_MILLISECONDS
      );
      expect(fastestMilliseconds(() => canonicalIngredientKey(input))).toBeLessThan(
        MAX_MILLISECONDS
      );
    }
  });

  it("keeps the names it always produced", () => {
    expect(cleanShoppingItemName("milk (skim, 1% or whole), cold")).toBe("milk");
    expect(cleanShoppingItemName("flour [sifted]  (see note)")).toBe("flour");
    expect(cleanShoppingItemName("water* †")).toBe("water");
    expect(cleanShoppingItemName("salt, to taste")).toBe("salt");
    expect(cleanShoppingItemName("black pepper  to taste")).toBe("black pepper");
    expect(cleanShoppingItemName("olive oil plus more for the pan")).toBe("olive oil");
    expect(cleanShoppingItemName("(optional)")).toBe("(optional)");
  });
});

describe("recipe import on hostile input", () => {
  const paprika = { name: "Soup", ingredients: "1 cup water", directions: "Boil." };

  it("trims trailing slashes off the synthetic source base in linear time", () => {
    const syntheticSourceBase = `https://linkdish.ca/imported${"/".repeat(HOSTILE)}x`;

    expect(
      fastestMilliseconds(() => paprikaRecipeToRecipe(paprika, { syntheticSourceBase }))
    ).toBeLessThan(MAX_MILLISECONDS);
    expect(
      paprikaRecipeToRecipe(paprika, { syntheticSourceBase: "https://linkdish.ca/imported///" })
        .meta.sourceUrl
    ).toMatch(/^https:\/\/linkdish\.ca\/imported\/soup-[0-9a-z]+$/u);
  });
});
