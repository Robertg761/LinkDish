import { describe, expect, it } from "vitest";

import {
  canonicalIngredientKey,
  categorizeIngredient,
  cleanShoppingItemName,
  extractFirstUrl,
  getDisplayIngredient,
  getDisplayIngredientText,
  melaRecipeToRecipe,
  mergeShoppingInputs,
  normalizeFractionSlashes,
  paprikaRecipeToRecipe,
  parseIngredientQuantity,
  parseNumberPhrase,
  parseServings,
  parseStepDurations,
  schemaOrgRecipeToRecipe
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

/*
 * Markup takes several linear passes over up to half again the input, more work per character
 * than the other checks, so on a loaded machine a bare 50 ms gets tight. It is held against the
 * same call on ordinary markup of the same length instead: linear work on these inputs takes up
 * to about 5 times as long as that, quadratic work over 500 times (2–4 s at 100,000 characters
 * for the tag pattern this replaced). The limit sits between the two with room for a busy
 * machine, whose time slices can land in the middle of a few-millisecond call.
 */
const MAX_MARKUP_SLOWDOWN = 100;

/**
 * How many times longer `run` takes than `ordinary`: the least of three trials that each time
 * the two back to back, so load slows both alike and a pause in one trial cannot fail a check.
 */
const slowdown = (run: () => unknown, ordinary: () => unknown): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      ordinary();
      const ordinaryDone = performance.now();
      run();
      return (performance.now() - ordinaryDone) / (ordinaryDone - started);
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

  it("reads a long chain of hyphenated numbers in linear time, without recursing", () => {
    const chain = `${"1-".repeat(HOSTILE / 2)}1`;

    expect(parseNumberPhrase(chain)).toBeNull();
    expect(parseNumberPhrase(`1 ${chain}`)).toBeNull();
    expect(fastestMilliseconds(() => parseNumberPhrase(chain))).toBeLessThan(MAX_MILLISECONDS);
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

  it("collects categories in linear time, stopping at the tag limit", () => {
    const categories = Array.from({ length: 20_000 }, (_, index) => `c${index}`);
    const repeated = Array.from({ length: 20_000 }, (_, index) =>
      index % 2 ? "Dinner" : "dinner"
    );

    expect(paprikaRecipeToRecipe({ ...paprika, categories }).meta.tags).toEqual(
      categories.slice(0, 50)
    );
    expect(paprikaRecipeToRecipe({ ...paprika, categories: repeated }).meta.tags).toEqual([
      "dinner"
    ]);
    expect(
      fastestMilliseconds(() => paprikaRecipeToRecipe({ ...paprika, categories }))
    ).toBeLessThan(MAX_MILLISECONDS);
    expect(
      fastestMilliseconds(() =>
        melaRecipeToRecipe({
          title: "Soup",
          ingredients: "1 cup water",
          instructions: "Boil.",
          categories: categories.join(",")
        })
      )
    ).toBeLessThan(MAX_MILLISECONDS);
  });
});

describe("ingredient display on hostile input", () => {
  const letters = "a".repeat(HOSTILE);

  it("finds the noun to inflect in linear time after a long run of letters", () => {
    const inputs = [
      `2 ${letters} eggs`,
      `2 ${letters}1`,
      `2 eggs ${"-".repeat(HOSTILE)}!`,
      `2 ${"é".repeat(HOSTILE)}1`
    ];

    expect(getDisplayIngredient(`2 ${letters} eggs`, { scale: 0.5 }).text).toBe(`1 ${letters} egg`);

    for (const input of inputs) {
      expect(
        fastestMilliseconds(() => getDisplayIngredient(input, { scale: 2 })),
        input.slice(0, 12)
      ).toBeLessThan(MAX_MILLISECONDS);
      expect(
        fastestMilliseconds(() => getDisplayIngredientText(input, { units: "us" })),
        input.slice(0, 12)
      ).toBeLessThan(MAX_MILLISECONDS);
    }
  });

  it("steps over leading notes in linear time", () => {
    const text = `1 ${"()".repeat(HOSTILE / 2)}egg`;

    expect(getDisplayIngredient(text, { scale: 2 }).text).toBe(`2 ${"()".repeat(HOSTILE / 2)}eggs`);
    expect(fastestMilliseconds(() => getDisplayIngredient(text, { scale: 2 }))).toBeLessThan(
      MAX_MILLISECONDS
    );
  });
});

/*
 * The aisle rules are a dozen case-insensitive word patterns, each run over the whole line, so
 * any 100,000-character line takes 5–25 ms here: too close to a bare 50 ms on a loaded machine.
 * Like the markup checks, these are held against an ordinary line of the same length instead;
 * the quadratic note pattern this replaced was over 500 times slower (12 s at this length).
 */
const MAX_AISLE_SLOWDOWN = 100;

describe("shopping aisles on hostile input", () => {
  const inputs = [
    `${"(".repeat(HOSTILE)}x`,
    `${"[".repeat(HOSTILE)}x`,
    `2 cups ${"(".repeat(HOSTILE)}`
  ];
  const ordinary = `2 cups ${"flour ".repeat(HOSTILE / 6)}`;

  it("files items in linear time, even with a long run of unclosed '(' or '['", () => {
    for (const input of inputs) {
      expect(
        slowdown(
          () => categorizeIngredient(input),
          () => categorizeIngredient(ordinary)
        ),
        input.slice(0, 8)
      ).toBeLessThan(MAX_AISLE_SLOWDOWN);
      expect(
        slowdown(
          () => mergeShoppingInputs([{ text: input }]),
          () => mergeShoppingInputs([{ text: ordinary }])
        ),
        input.slice(0, 8)
      ).toBeLessThan(MAX_AISLE_SLOWDOWN);
    }
  });
});

describe("links in shared text on hostile input", () => {
  it("drops trailing punctuation in linear time", () => {
    const closers = `https://a.co/${")".repeat(HOSTILE)}`;
    const mixed = `https://a.co/x${".)".repeat(HOSTILE / 2)}`;

    expect(extractFirstUrl(closers)).toBe("https://a.co/");
    expect(extractFirstUrl(mixed)).toBe("https://a.co/x");
    expect(fastestMilliseconds(() => extractFirstUrl(closers))).toBeLessThan(MAX_MILLISECONDS);
    expect(fastestMilliseconds(() => extractFirstUrl(mixed))).toBeLessThan(MAX_MILLISECONDS);
  });
});

/*
 * CodeQL incomplete multi-character sanitization: one pass of the tag pattern could leave a tag
 * that nesting rebuilt ("<scr<b>ipt>"), an unclosed "<script", or entity-encoded markup that
 * only became a tag after decoding.
 */
describe("recipe import markup", () => {
  const TAG_OPENER = /<[!/?A-Za-z]/u;
  const importDescription = (description: string): string | null =>
    schemaOrgRecipeToRecipe({
      "@type": "Recipe",
      name: "Soup",
      description,
      recipeIngredient: ["1 cup water"],
      recipeInstructions: "Boil."
    }).recipe?.description ?? null;

  it("strips tags that nesting or entity-encoding would rebuild", () => {
    expect(importDescription("<scr<b>ipt>alert(1)</scr</b>ipt> Soft &amp; tender")).toBe(
      "alert(1) Soft & tender"
    );
    expect(importDescription("&lt;p&gt;Serve warm.&lt;/p&gt;")).toBe("Serve warm.");
    expect(importDescription("&lt;scr&lt;b&gt;ipt&gt;alert(1)")).toBe("alert(1)");
    expect(importDescription("Mix well <script src=x")).toBe("Mix well < script src=x");
    expect(importDescription("Line one<br>Line two</p>Line three")).toBe(
      "Line one\nLine two\nLine three"
    );
  });

  it("keeps comparisons that only look like markup", () => {
    expect(importDescription("Cook to < 165°F, then rest > 5 min")).toBe(
      "Cook to < 165°F, then rest > 5 min"
    );
    expect(importDescription("Cook to &lt; 165&deg;F &lt;3")).toBe("Cook to < 165°F <3");
  });

  it("strips a tag whole when a quoted attribute value holds '<' or '>'", () => {
    expect(importDescription('<img src="step1.jpg" alt="Cook to < 165°F">Cook the chicken.')).toBe(
      "Cook the chicken."
    );
    expect(importDescription('<a href="/x" title="I <3 this">Grandma</a> recipe')).toBe(
      "Grandma recipe"
    );
    expect(
      importDescription("<p>Roast until done.</p><img alt='Temp <165°F'><p>Rest 5 min.</p>")
    ).toBe("Roast until done.\nRest 5 min.");
    expect(importDescription("<img alt='a > b' src=x>Serve")).toBe("Serve");
    expect(importDescription("<o:p></o:p>Serve warm.<o:p>&nbsp;</o:p>")).toBe("Serve warm.");
  });

  it("keeps a less-than sign that opens no tag, with every word after it", () => {
    expect(importDescription("Heat to <medium, then simmer")).toBe("Heat to < medium, then simmer");
    expect(importDescription("if a<b then")).toBe("if a< b then");
    expect(importDescription("Keep temp <<b>boiling</b>, stir if > 5 min")).toBe(
      "Keep temp < boiling, stir if > 5 min"
    );
    expect(importDescription("Heat oil to <<b>smoking</b>, about 2 min > then add")).toBe(
      "Heat oil to < smoking, about 2 min > then add"
    );
    expect(importDescription("Jane Doe <jane@example.com>")).toBe("Jane Doe < jane@example.com>");
  });

  it("reads entity-encoded tags as the extractor does", () => {
    expect(importDescription("a&lt;br&gt;b")).toBe("a\nb");
    expect(importDescription("Contact &lt;chef@example.com&gt; with questions")).toBe(
      "Contact < chef@example.com> with questions"
    );
    expect(importDescription("&lt;https://example.com&gt;")).toBe("< https://example.com>");
    // Shaped like a tag once decoded, so it goes, as in htmlFragmentToText.
    expect(importDescription("Serve with &lt;your favorite&gt; sauce")).toBe("Serve with sauce");
  });

  it("strips markup in linear time and leaves no tag opener, however deep the nesting", () => {
    const fit = (unit: string): string => unit.repeat(Math.ceil(HOSTILE / unit.length));
    const inputs = [
      "<".repeat(HOSTILE),
      "<a".repeat(HOSTILE / 2),
      `${"<a".repeat(HOSTILE / 4)}${">".repeat(HOSTILE / 4)}`,
      `${"&lt;a".repeat(HOSTILE / 8)}${"&gt;".repeat(HOSTILE / 8)}`,
      `<a "${fit("<a ")}`,
      fit(`<a "<a '`)
    ];
    const ordinary = fit('<p>Stir <b>well</b> &amp; <a href="/x" title="rest">rest</a>.</p>');

    for (const input of inputs) {
      expect(TAG_OPENER.test(importDescription(input) ?? "")).toBe(false);
      expect(
        slowdown(
          () => importDescription(input),
          () => importDescription(ordinary)
        )
      ).toBeLessThan(MAX_MARKUP_SLOWDOWN);
    }
  });
});
