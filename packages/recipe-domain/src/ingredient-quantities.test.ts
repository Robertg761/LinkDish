import { describe, expect, it } from "vitest";

import { parseIngredientQuantity, scaleQuantity } from "./index";

describe("parseIngredientQuantity", () => {
  it("parses measured ingredients with bracketed alternate quantities", () => {
    expect(parseIngredientQuantity("2 cups [280 g] all-purpose flour")).toEqual({
      qty: 2,
      unit: "cup",
      altQty: 280,
      altUnit: "g",
      item: "all-purpose flour",
      confident: true
    });
  });

  it("parses fractions, mixed numbers, unicode fractions, ranges, and whole counts", () => {
    expect(parseIngredientQuantity("1/2 tsp salt")).toEqual({
      qty: 0.5,
      unit: "tsp",
      altQty: null,
      altUnit: null,
      item: "salt",
      confident: true
    });
    expect(parseIngredientQuantity("1 1/2 cups milk")).toMatchObject({
      qty: 1.5,
      unit: "cup",
      item: "milk",
      confident: true
    });
    expect(parseIngredientQuantity("½ cup olive oil")).toMatchObject({
      qty: 0.5,
      unit: "cup",
      item: "olive oil",
      confident: true
    });
    expect(parseIngredientQuantity("2-3 Tbsp lemon juice")).toEqual({
      qty: { min: 2, max: 3 },
      unit: "Tbsp",
      altQty: null,
      altUnit: null,
      item: "lemon juice",
      confident: true
    });
    expect(parseIngredientQuantity("3 large eggs")).toEqual({
      qty: 3,
      unit: null,
      altQty: null,
      altUnit: null,
      item: "large eggs",
      confident: true
    });
  });

  it("leaves unconfident lines verbatim so scaling can skip them", () => {
    expect(parseIngredientQuantity("Salt to taste")).toEqual({
      qty: null,
      unit: null,
      altQty: null,
      altUnit: null,
      item: "Salt to taste",
      confident: false
    });
    expect(parseIngredientQuantity("A generous pinch of cinnamon")).toMatchObject({
      item: "A generous pinch of cinnamon",
      confident: false
    });
  });
});

describe("scaleQuantity", () => {
  it("uses vulgar fractions for cup and spoon units", () => {
    expect(scaleQuantity(parseIngredientQuantity("1/2 tsp salt"), 2)).toBe("1 tsp salt");
    expect(scaleQuantity(parseIngredientQuantity("1 1/2 cups milk"), 0.5)).toBe("¾ cup milk");
    expect(scaleQuantity(parseIngredientQuantity("2-3 Tbsp lemon juice"), 0.5)).toBe(
      "1–1 ½ Tbsp lemon juice"
    );
  });

  it("scales alternate metric quantities when present", () => {
    expect(scaleQuantity(parseIngredientQuantity("2 cups [280 g] all-purpose flour"), 0.5)).toBe(
      "1 cup [140 g] all-purpose flour"
    );
    expect(scaleQuantity(parseIngredientQuantity("2 cups [280 g] all-purpose flour"), 2)).toBe(
      "4 cups [560 g] all-purpose flour"
    );
  });

  it("uses whole-number ranges for eggs and whole-item quantities", () => {
    const scaledEggs = scaleQuantity(parseIngredientQuantity("3 large eggs"), 0.5);
    const scaledCans = scaleQuantity(parseIngredientQuantity("1 can chickpeas"), 1.5);

    expect(scaledEggs).toBe("1–2 large eggs");
    expect(scaledEggs).not.toContain("1.5");
    expect(scaleQuantity(parseIngredientQuantity("2 eggs"), 0.665)).toBe("1–2 eggs");
    expect(scaleQuantity(parseIngredientQuantity("2 eggs"), 0.665)).not.toContain("1.33");
    expect(scaledCans).toBe("1–2 cans chickpeas");
  });

  it("keeps unconfident lines unchanged", () => {
    expect(scaleQuantity(parseIngredientQuantity("Salt to taste"), 2)).toBe("Salt to taste");
  });
});

describe("fraction rendering (bug 1)", () => {
  it("renders thirds instead of snapping everything to eighths", () => {
    expect(scaleQuantity(parseIngredientQuantity("1/3 cup sugar"), 1)).toBe("⅓ cup sugar");
    expect(scaleQuantity(parseIngredientQuantity("2/3 cup milk"), 1)).toBe("⅔ cup milk");
    expect(scaleQuantity(parseIngredientQuantity("1 1/3 cups flour"), 1)).toBe("1 ⅓ cups flour");
    expect(scaleQuantity(parseIngredientQuantity("1/6 cup cream"), 1)).toBe("⅙ cup cream");
  });

  it("falls back to a decimal instead of fabricating a nearby fraction", () => {
    expect(scaleQuantity(parseIngredientQuantity("1/16 tsp salt"), 1)).toBe("0.06 tsp salt");
    expect(scaleQuantity(parseIngredientQuantity("1/8 tsp salt"), 0.5)).toBe("0.06 tsp salt");
  });

  it("still renders the familiar eighths and quarters exactly", () => {
    expect(scaleQuantity(parseIngredientQuantity("1/8 cup oats"), 1)).toBe("⅛ cup oats");
    expect(scaleQuantity(parseIngredientQuantity("3/8 cup oats"), 1)).toBe("⅜ cup oats");
    expect(scaleQuantity(parseIngredientQuantity("5/8 cup oats"), 1)).toBe("⅝ cup oats");
    expect(scaleQuantity(parseIngredientQuantity("7/8 cup oats"), 1)).toBe("⅞ cup oats");
    expect(scaleQuantity(parseIngredientQuantity("1/4 cup oats"), 1)).toBe("¼ cup oats");
  });
});

describe("unit coverage (bug 2)", () => {
  it("recognizes common volume abbreviations so they scale", () => {
    expect(scaleQuantity(parseIngredientQuantity("1 tbs olive oil"), 0.5)).toBe("½ Tbsp olive oil");
    expect(scaleQuantity(parseIngredientQuantity("1 fl oz vodka"), 0.5)).toBe("½ fl oz vodka");
    expect(scaleQuantity(parseIngredientQuantity("1 dash bitters"), 0.5)).toBe("½ dash bitters");
    expect(scaleQuantity(parseIngredientQuantity("1 bunch parsley"), 0.5)).toBe("½ bunch parsley");
    expect(scaleQuantity(parseIngredientQuantity("2 quarts stock"), 0.5)).toBe("1 qt stock");
    expect(scaleQuantity(parseIngredientQuantity("2 pt cream"), 0.5)).toBe("1 pt cream");
    expect(scaleQuantity(parseIngredientQuantity("1 gal water"), 0.5)).toBe("½ gal water");
    expect(scaleQuantity(parseIngredientQuantity("2 slices bread"), 0.5)).toBe("1 slice bread");
    expect(scaleQuantity(parseIngredientQuantity("2 pkg tofu"), 0.5)).toBe("1 package tofu");
  });

  it("maps case-sensitive single-letter abbreviations to the right unit", () => {
    expect(parseIngredientQuantity("2 T sugar")).toMatchObject({ qty: 2, unit: "Tbsp", item: "sugar" });
    expect(parseIngredientQuantity("1 t vanilla")).toMatchObject({ qty: 1, unit: "tsp", item: "vanilla" });
    expect(parseIngredientQuantity("1 c flour")).toMatchObject({ qty: 1, unit: "cup", item: "flour" });
    expect(parseIngredientQuantity("1 c. flour")).toMatchObject({ qty: 1, unit: "cup", item: "flour" });
    expect(parseIngredientQuantity("2 T-bone steaks")).toMatchObject({ qty: 2, unit: null, item: "T-bone steaks" });
  });

  it("does not silently floor a scaled-down single item to 1", () => {
    expect(scaleQuantity(parseIngredientQuantity("1 can chickpeas"), 0.5)).toBe("½ can chickpeas");
    expect(scaleQuantity(parseIngredientQuantity("1 egg"), 0.5)).toBe("½ egg");
  });
});

describe("pluralization (bug 3)", () => {
  it("pluralizes from the displayed number, not the raw float", () => {
    expect(scaleQuantity(parseIngredientQuantity("3/4 cup butter"), 1.4)).toBe("1 cup butter");
    expect(scaleQuantity(parseIngredientQuantity("1 cup rice"), 1.05)).toBe("1 cup rice");
    expect(scaleQuantity(parseIngredientQuantity("1 cup rice"), 2)).toBe("2 cups rice");
  });
});

describe("amount-only lines (bug 4)", () => {
  it("scales lines that carry a quantity and unit but no item text", () => {
    expect(parseIngredientQuantity("2 cups")).toMatchObject({ qty: 2, unit: "cup", item: "", confident: true });
    expect(scaleQuantity(parseIngredientQuantity("2 cups"), 0.5)).toBe("1 cup");
    expect(parseIngredientQuantity("10 1/2 oz")).toMatchObject({ qty: 10.5, unit: "oz", confident: true });
    expect(scaleQuantity(parseIngredientQuantity("10 1/2 oz"), 2)).toBe("21 oz");
  });

  it("still refuses a bare number with no unit and no item", () => {
    expect(parseIngredientQuantity("3")).toMatchObject({ confident: false, item: "3" });
  });
});

describe("bad scale factors (bug 5)", () => {
  it("returns the line at factor 1 instead of dropping the amount", () => {
    const parsed = parseIngredientQuantity("2 cups flour");

    expect(scaleQuantity(parsed, 0)).toBe("2 cups flour");
    expect(scaleQuantity(parsed, -3)).toBe("2 cups flour");
    expect(scaleQuantity(parsed, Number.NaN)).toBe("2 cups flour");
    expect(scaleQuantity(parsed, Number.POSITIVE_INFINITY)).toBe("2 cups flour");
  });
});

describe("shared number phrases (bug 7)", () => {
  it("reads every vulgar fraction the timer parser knows", () => {
    expect(parseIngredientQuantity("⅕ cup broth")).toMatchObject({ qty: 0.2, unit: "cup", confident: true });
    expect(parseIngredientQuantity("⅙ cup cream")).toMatchObject({ unit: "cup", confident: true });
    expect(parseIngredientQuantity("⅚ cup water")).toMatchObject({ unit: "cup", confident: true });
  });
});

describe("zero quantities (bug 8)", () => {
  it("treats a zero amount as unconfident", () => {
    expect(parseIngredientQuantity("0 cups sugar")).toMatchObject({ confident: false, item: "0 cups sugar" });
    expect(scaleQuantity(parseIngredientQuantity("0 cups sugar"), 2)).toBe("0 cups sugar");
  });
});

describe("unit matching performance (bug 9)", () => {
  it("does not build regexes inside parseUnit", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./ingredient-quantities.ts", import.meta.url), "utf8");
    const start = source.indexOf("const parseUnit");
    const end = source.indexOf("const parseAltQuantity");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("new RegExp");
  });
});

describe("scale round-trip", () => {
  const roundTripInputs = [
    "1/3 cup sugar",
    "2/3 cup milk",
    "1 1/2 cups milk",
    "3/4 cup butter",
    "2 cups [280 g] all-purpose flour",
    "2-3 Tbsp lemon juice",
    "3 large eggs",
    "1 can chickpeas",
    "12 oz pasta",
    "1 tbs olive oil",
    "1 fl oz vodka",
    "1 dash bitters",
    "1 bunch parsley",
    "2 cups",
    "1 1/3 cups flour"
  ];
  const roundTripFactors = [0.05, 0.25, 0.5, 0.665, 1, 1.05, 1.4, 1.5, 2, 3, 50, 1e21, 1e-9];

  it("re-parses its own output confidently for every input and factor", () => {
    for (const input of roundTripInputs) {
      for (const factor of roundTripFactors) {
        const scaled = scaleQuantity(parseIngredientQuantity(input), factor);
        const context = `${input} x${factor} -> ${scaled}`;

        expect(scaled, context).not.toMatch(/e[+-]\d/i);
        expect(scaled, context).not.toMatch(/NaN|Infinity/);

        const reparsed = parseIngredientQuantity(scaled);
        expect(reparsed.confident, context).toBe(true);
        expect(parseIngredientQuantity(scaleQuantity(reparsed, 1)).confident, context).toBe(true);
      }
    }
  });

  it("clamps absurd factors instead of emitting exponent notation", () => {
    expect(scaleQuantity(parseIngredientQuantity("1 cup flour"), 1e21)).toBe("50 cups flour");
    expect(scaleQuantity(parseIngredientQuantity("1 cup flour"), 1e-9)).toBe("0.05 cup flour");
  });

  it("renders both ends of a range in the same notation", () => {
    // Formatting each end independently produced a mismatched "0.08–⅙ tsp":
    // the low end had no close fraction and fell back to a decimal while the
    // high end kept one.
    const cayenne = parseIngredientQuantity("¼-½ tsp cayenne");

    expect(scaleQuantity(cayenne, 1 / 3)).toBe("0.08–0.17 tsp cayenne");
    expect(scaleQuantity(cayenne, 1)).toBe("¼–½ tsp cayenne");
  });

  it("collapses a range whose ends render alike", () => {
    const cayenne = parseIngredientQuantity("¼-½ tsp cayenne");

    // Both ends land on the same printable fraction once scaled far enough
    // down; "⅛–⅛ tsp" is not a range a cook can act on.
    const scaled = scaleQuantity(cayenne, 0.4);

    expect(scaled).not.toMatch(/(.+)–\1/u);
  });
});
