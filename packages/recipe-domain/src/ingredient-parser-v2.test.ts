import { describe, expect, it } from "vitest";

import {
  formatParsedIngredient,
  inflectIngredientPhrase,
  isPluralNoun,
  parseIngredientQuantity,
  parseNumberPhrase,
  pluralizeNoun,
  scaleQuantity,
  singularizeNoun,
  transformEmbeddedAmounts
} from "./index.js";

import type { ParsedQuantityValue } from "./index.js";

const scaled = (text: string, factor: number): string =>
  scaleQuantity(parseIngredientQuantity(text), factor);

describe("hyphenated mixed numbers (bug 10)", () => {
  it("reads 1-1/2 as one and a half, not a range from a half to one", () => {
    expect(parseIngredientQuantity("1-1/2 cups flour")).toEqual({
      qty: 1.5,
      unit: "cup",
      altQty: null,
      altUnit: null,
      item: "flour",
      confident: true
    });
    expect(scaled("1-1/2 cups flour", 2)).toBe("3 cups flour");
    expect(parseIngredientQuantity("2-3/4 cups stock")).toMatchObject({ qty: 2.75 });
    expect(parseIngredientQuantity("1-½ tsp salt")).toMatchObject({ qty: 1.5, unit: "tsp" });
  });

  it("still reads ranges that start with a fraction or end with a whole number", () => {
    expect(parseIngredientQuantity("1/2-1 cup water")).toMatchObject({
      qty: { min: 0.5, max: 1 },
      unit: "cup"
    });
    expect(parseIngredientQuantity("1-2 cups water")).toMatchObject({ qty: { min: 1, max: 2 } });
    expect(parseIngredientQuantity("1 - 1 1/2 cups water")).toMatchObject({
      qty: { min: 1, max: 1.5 }
    });
  });

  it("parses the same forms as standalone number phrases", () => {
    expect(parseNumberPhrase("1-1/2")).toBe(1.5);
    expect(parseNumberPhrase("1½")).toBe(1.5);
    expect(parseNumberPhrase("1 ½")).toBe(1.5);
    expect(parseNumberPhrase("1⁄2")).toBe(0.5);
    expect(parseNumberPhrase(".5")).toBe(0.5);
    expect(parseNumberPhrase("five")).toBe(5);
    expect(parseNumberPhrase("forty-five")).toBe(45);
    expect(parseNumberPhrase("3-4")).toBeNull();
  });
});

describe("unicode, glued and spelled-out amounts (bug 11)", () => {
  const corpus: ReadonlyArray<{
    text: string;
    qty: ParsedQuantityValue;
    unit: string | null;
    item: string;
  }> = [
    { text: "1½ cups milk", qty: 1.5, unit: "cup", item: "milk" },
    { text: "1 ½ cups milk", qty: 1.5, unit: "cup", item: "milk" },
    { text: "1⁄2 cup sugar", qty: 0.5, unit: "cup", item: "sugar" },
    { text: "1 ⁄ 2 cup sugar", qty: 0.5, unit: "cup", item: "sugar" },
    { text: "1 1⁄2 cups sugar", qty: 1.5, unit: "cup", item: "sugar" },
    { text: ".5 cup oil", qty: 0.5, unit: "cup", item: "oil" },
    { text: "200g pasta", qty: 200, unit: "g", item: "pasta" },
    { text: "250ml stock", qty: 250, unit: "ml", item: "stock" },
    { text: "1.5kg potatoes", qty: 1.5, unit: "kg", item: "potatoes" },
    { text: "2cups rice", qty: 2, unit: "cup", item: "rice" },
    { text: "10oz spinach", qty: 10, unit: "oz", item: "spinach" },
    { text: "1 litre water", qty: 1, unit: "l", item: "water" },
    { text: "500 millilitres milk", qty: 500, unit: "ml", item: "milk" },
    { text: "2 tbsp. honey", qty: 2, unit: "Tbsp", item: "honey" },
    { text: "1 tablespoonful butter", qty: 1, unit: "Tbsp", item: "butter" },
    { text: "3 sprigs thyme", qty: 3, unit: "sprig", item: "thyme" },
    { text: "2 stalks celery", qty: 2, unit: "stalk", item: "celery" },
    { text: "1 head of garlic", qty: 1, unit: "head", item: "garlic" },
    { text: "one onion, diced", qty: 1, unit: null, item: "onion, diced" },
    { text: "Two large eggs", qty: 2, unit: null, item: "large eggs" },
    { text: "2 or 3 cloves garlic", qty: { min: 2, max: 3 }, unit: "clove", item: "garlic" },
    { text: "1 cup to 1 1/4 cups milk", qty: { min: 1, max: 1.25 }, unit: "cup", item: "milk" },
    { text: "2 cups of water", qty: 2, unit: "cup", item: "water" }
  ];

  it("parses the labelled corpus", () => {
    expect(corpus).toHaveLength(23);

    for (const { text, qty, unit, item } of corpus) {
      expect(parseIngredientQuantity(text), text).toMatchObject({
        qty,
        unit,
        item,
        confident: true
      });
    }
  });

  it("scales glued metric amounts", () => {
    expect(scaled("200g pasta", 2)).toBe("400 g pasta");
    expect(scaled("1½ cups milk", 2)).toBe("3 cups milk");
    expect(scaled("1 ⁄ 2 cup sugar", 2)).toBe("1 cup sugar");
  });

  it("refuses glued text that is not a unit", () => {
    expect(parseIngredientQuantity("2T-bone steaks").confident).toBe(false);
    expect(parseIngredientQuantity("5cm piece ginger").confident).toBe(false);
    expect(parseIngredientQuantity("3x chicken").confident).toBe(false);
  });

  it("keeps the unicode fraction slash out of the scaled text", () => {
    expect(scaled("1 ⁄ 2 cup sugar", 1)).toBe("½ cup sugar");
    expect(scaled("1 ⁄ 2 cup sugar", 2)).not.toContain("⁄");
  });
});

describe("parenthetical alternate amounts (bug 12)", () => {
  it("reads a parenthetical weight after a measurement as the alternate amount", () => {
    expect(parseIngredientQuantity("3 cups (360g) King Arthur Flour")).toEqual({
      qty: 3,
      unit: "cup",
      altQty: 360,
      altUnit: "g",
      altStyle: "paren",
      item: "King Arthur Flour",
      confident: true
    });
  });

  it("scales the alternate with the amount so the line never contradicts itself", () => {
    expect(scaled("3 cups (360g) flour", 2)).toBe("6 cups (720 g) flour");
    expect(scaled("2 tablespoons (25g) granulated sugar", 0.5)).toBe(
      "1 Tbsp (13 g) granulated sugar"
    );
    expect(scaled("1/2 to 2/3 cup (113g to 152g) hot water", 2)).toBe(
      "1–1 ⅓ cups (226–304 g) hot water"
    );
    expect(scaled("1 stick (113g) butter", 2)).toBe("2 sticks (226 g) butter");
  });

  it("keeps square brackets for bracketed alternates", () => {
    expect(scaled("2 cups [280 g] flour", 0.5)).toBe("1 cup [140 g] flour");
  });

  it("leaves notes that are not amounts in the item", () => {
    expect(parseIngredientQuantity("1 cup milk (whole or 2%)")).toMatchObject({
      altQty: null,
      item: "milk (whole or 2%)"
    });
    expect(parseIngredientQuantity("2 cups (packed) spinach")).toMatchObject({
      altQty: null,
      item: "(packed) spinach"
    });
  });
});

describe("package sizes (bug 13)", () => {
  it("keeps a size between the count and the unit fixed while the count scales", () => {
    expect(parseIngredientQuantity("1 (15-ounce) can chickpeas, drained")).toMatchObject({
      qty: 1,
      unit: "can",
      altQty: null,
      item: "chickpeas, drained",
      packageSize: { text: "15-ounce", qty: 15, unit: "oz", style: "paren", afterUnit: false }
    });
    expect(scaled("1 (15-ounce) can chickpeas", 2)).toBe("2 (15-ounce) cans chickpeas");
    expect(scaled("2 (14 oz) cans", 0.5)).toBe("1 (14 oz) can");
    expect(scaled("1 (28 ounce) can diced tomatoes", 3)).toBe("3 (28 ounce) cans diced tomatoes");
  });

  it("reads a size after a packaging unit as the package size, not an alternate", () => {
    expect(parseIngredientQuantity("1 can (15 oz) black beans")).toMatchObject({
      unit: "can",
      altQty: null,
      packageSize: { text: "15 oz", afterUnit: true }
    });
    expect(scaled("1 can (15 oz) black beans", 2)).toBe("2 cans (15 oz) black beans");
    expect(scaled("1 package (8 oz) cream cheese, softened", 2)).toBe(
      "2 packages (8 oz) cream cheese, softened"
    );
  });

  it("reads glued and multiplied sizes", () => {
    expect(scaled("2 14.5-oz cans diced tomatoes", 0.5)).toBe("1 14.5-oz can diced tomatoes");
    expect(scaled("2 x 400g tins chopped tomatoes", 0.5)).toBe("1 x 400g tin chopped tomatoes");
    expect(scaled("One 15-ounce can tomato sauce", 2)).toBe("2 15-ounce cans tomato sauce");
    expect(scaled("2 (6 ounce) salmon fillets", 0.5)).toBe("1 (6 ounce) salmon fillet");
  });

  it("does not scale measurements inside a packaged line's notes", () => {
    expect(scaled("1 package yeast (2 1/4 tsp)", 2)).toBe("2 packages yeast (2 1/4 tsp)");
  });
});

describe("noun inflection when scaling (bug 14)", () => {
  const corpus: ReadonlyArray<readonly [string, number, string]> = [
    ["1 large egg", 2, "2 large eggs"],
    ["2 large eggs, beaten", 0.5, "1 large egg, beaten"],
    ["1 egg", 3, "3 eggs"],
    ["2 (14 oz) cans", 0.5, "1 (14 oz) can"],
    ["3 -4 garlic cloves, minced", 0.25, "1 garlic clove, minced"],
    ["1 red bell pepper, thinly sliced", 2, "2 red bell peppers, thinly sliced"],
    ["2 scallions, sliced", 0.5, "1 scallion, sliced"],
    ["1 Persian cucumber, diced", 2, "2 Persian cucumbers, diced"],
    ["2 pita pockets, halved", 0.5, "1 pita pocket, halved"],
    ["1 bay leaf", 2, "2 bay leaves"],
    ["10 fresh basil leaves", 0.1, "1 fresh basil leaf"],
    ["1 tomato", 2, "2 tomatoes"],
    ["1 peach, sliced", 2, "2 peaches, sliced"],
    ["1 cherry", 3, "3 cherries"],
    ["2 cookies", 0.5, "1 cookie"],
    ["1 small onion, chopped (optional)", 2, "2 small onions, chopped (optional)"],
    ["4 chicken breasts (about 2 lbs)", 0.5, "2 chicken breasts (about 1 lb)"],
    ["1 (8 inch) pie crust", 2, "2 (8 inch) pie crusts"],
    ["1 cinnamon stick", 2, "2 cinnamon sticks"],
    ["12 shrimp", 0.5, "6 shrimp"],
    ["1 dozen eggs", 2, "2 dozen eggs"],
    ["2 garlic, minced", 0.5, "1 garlic, minced"],
    ["3 large eggs", 0.5, "1–2 large eggs"],
    ["1 egg", 0.5, "½ egg"],
    ["1 jalapeño, seeded", 2, "2 jalapeños, seeded"]
  ];

  it("agrees the head noun with the scaled count", () => {
    expect(corpus).toHaveLength(25);

    for (const [text, factor, expected] of corpus) {
      expect(scaled(text, factor), `${text} x${factor}`).toBe(expected);
    }
  });

  it("leaves measured lines alone: the unit carries the number", () => {
    expect(scaled("2 cups snap peas, strings removed", 0.5)).toBe(
      "1 cup snap peas, strings removed"
    );
    expect(scaled("1 teaspoon toasted sesame seeds", 2)).toBe("2 tsp toasted sesame seeds");
  });

  it("inflects nouns with food-aware rules", () => {
    expect(pluralizeNoun("berry")).toBe("berries");
    expect(pluralizeNoun("radish")).toBe("radishes");
    expect(pluralizeNoun("loaf")).toBe("loaves");
    expect(pluralizeNoun("rice")).toBe("rice");
    expect(pluralizeNoun("Egg")).toBe("Eggs");
    expect(singularizeNoun("cookies")).toBe("cookie");
    expect(singularizeNoun("anchovies")).toBe("anchovy");
    expect(singularizeNoun("potatoes")).toBe("potato");
    expect(singularizeNoun("quiches")).toBe("quiche");
    expect(singularizeNoun("glasses")).toBe("glass");
    expect(singularizeNoun("cloves")).toBe("clove");
    expect(singularizeNoun("asparagus")).toBe("asparagus");
    expect(singularizeNoun("hummus")).toBe("hummus");
    expect(isPluralNoun("eggs")).toBe(true);
    expect(isPluralNoun("couscous")).toBe(false);
    expect(inflectIngredientPhrase("large eggs, beaten", 2, 1)).toBe("large egg, beaten");
  });
});

describe("amounts inside the item text (bug 15)", () => {
  it("scales a second measured amount in the same line", () => {
    expect(scaled("4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil", 2)).toBe(
      "8 Tbsp (114 g) melted butter or ½ cup (100 g) vegetable oil"
    );
    expect(
      scaled(
        "1 teaspoon hickory smoke salt, if you cannot find, you can substitute 1 1/2 to 2 teaspoons Hickory liquid smoke",
        2
      )
    ).toBe(
      "2 tsp hickory smoke salt, if you cannot find, you can substitute 3–4 tsp Hickory liquid smoke"
    );
    expect(
      scaled("3/4 teaspoon table salt, (use 1/2 teaspoon salt if you use salted butter)", 2)
    ).toBe("1 ½ tsp table salt, (use 1 tsp salt if you use salted butter)");
  });

  it("leaves package descriptions, adjectives and counts alone", () => {
    expect(scaled("8 oz. spaghetti (or 1/2 of a 1 lb box)", 2)).toBe(
      "16 oz spaghetti (or 1/2 of a 1 lb box)"
    );
    expect(scaled("1 lb chicken, cut into 1-inch pieces", 2)).toBe(
      "2 lb chicken, cut into 1-inch pieces"
    );
    expect(scaled("2 cups water (for a long period of simmering)", 2)).toBe(
      "4 cups water (for a long period of simmering)"
    );
    expect(scaled("1 lb ground beef (80/20)", 2)).toBe("2 lb ground beef (80/20)");
  });

  it("keeps the original text at factor 1", () => {
    expect(scaled("4 tablespoons (57g) butter or 1/4 cup (50g) oil", 1)).toBe(
      "4 Tbsp (57 g) butter or 1/4 cup (50g) oil"
    );
  });

  it("exposes the embedded-amount rewriter", () => {
    expect(
      transformEmbeddedAmounts("add 2 cups water and 1 tsp salt", (value, unit) =>
        typeof value === "number" ? `${value * 10} ${unit.canonical}` : null
      )
    ).toBe("add 20 cup water and 10 tsp salt");
  });

  it("formats a parsed line with a custom factor", () => {
    expect(formatParsedIngredient(parseIngredientQuantity("2 large eggs"), { factor: 1.5 })).toBe(
      "3 large eggs"
    );
  });
});
