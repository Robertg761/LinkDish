import { describe, expect, it } from "vitest";

import {
  addShoppingAmounts,
  addShoppingQuantities,
  canonicalIngredientKey,
  cleanShoppingItemName,
  findMergeableShoppingItem,
  formatShoppingItemText,
  isPantryStaple,
  MAX_SHOPPING_ITEM_TEXT_LENGTH,
  mergeShoppingInputs,
  mergeShoppingItemLists,
  parseShoppingLine,
  recipeIngredientsToShoppingInputs,
  SAMPLE_RECIPES,
  shoppingItemSchema
} from "./index.js";

describe("canonicalIngredientKey", () => {
  const corpus: ReadonlyArray<readonly [string, string]> = [
    ["2 large eggs, beaten", "egg"],
    ["1 egg", "egg"],
    ["3 Eggs", "egg"],
    ["1 cup chopped onion", "onion"],
    ["2 onions, diced", "onion"],
    ["3 cloves garlic, minced", "garlic"],
    ["2 garlic cloves", "garlic"],
    ["1 head garlic", "garlic"],
    ["2 scallions, sliced", "green onion"],
    ["1 bunch green onions", "green onion"],
    ["1 (15 oz) can chickpeas, drained", "chickpea"],
    ["1 can garbanzo beans", "chickpea"],
    ["1 cup all-purpose flour", "flour"],
    [
      "3 cups (360g) King Arthur Unbleached All-Purpose Flour",
      "king arthur unbleached all-purpose flour"
    ],
    ["2 cups flour", "flour"],
    ["1 cup bread flour", "bread flour"],
    ["1/2 cup packed brown sugar", "brown sugar"],
    ["1 cup granulated sugar", "sugar"],
    ["1 lb ground beef", "ground beef"],
    ["1 (28 oz) can crushed tomatoes", "crushed tomato"],
    ["1 tsp dried oregano", "dried oregano"],
    ["1 tsp smoked paprika", "smoked paprika"],
    ["2 tbsp unsalted butter, softened", "unsalted butter"],
    ["Salt to taste", "salt"],
    ["1 tsp kosher salt", "kosher salt"],
    ["1 jalapeño, seeded", "jalapeno"],
    ["1 cup fresh basil leaves", "basil"],
    ["2 tablespoons extra-virgin olive oil", "olive oil"],
    ["1 cup heavy whipping cream", "heavy cream"],
    ["3 stalks celery", "celery"],
    ["2 celery ribs, chopped", "celery"],
    ["Fresh parsley, for garnish", "parsley"],
    ["1 red bell pepper, thinly sliced", "red bell pepper"],
    ["1 cup cherry tomatoes, halved", "cherry tomato"],
    ["2 tbsp hummus", "hummus"],
    ["4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil", "butter"]
  ];

  it("keys the labelled corpus", () => {
    expect(corpus).toHaveLength(36);

    for (const [text, key] of corpus) {
      expect(canonicalIngredientKey(text), text).toBe(key);
    }
  });

  it("never returns an empty key", () => {
    for (const text of ["fresh", "large", "  ", "to taste"]) {
      expect(canonicalIngredientKey(text).length, text).toBeGreaterThanOrEqual(0);
    }

    expect(canonicalIngredientKey("fresh")).toBe("fresh");
  });

  it("recognizes pantry staples", () => {
    expect(isPantryStaple("Salt to taste")).toBe(true);
    expect(isPantryStaple("2 cups water")).toBe(true);
    expect(
      isPantryStaple("1/2 to 2/3 cup (113g to 152g) hot water, enough to make a soft dough")
    ).toBe(true);
    expect(isPantryStaple("Freshly ground black pepper")).toBe(true);
    expect(isPantryStaple("2 cups flour")).toBe(false);
  });
});

describe("parseShoppingLine", () => {
  it("parses lines into ShoppingItem fields", () => {
    expect(parseShoppingLine("2 large eggs, beaten")).toEqual({ qty: 2, text: "large eggs" });
    expect(parseShoppingLine("1 (15-ounce) can chickpeas, drained")).toEqual({
      qty: 1,
      unit: "can",
      text: "chickpeas (15-ounce)"
    });
    expect(parseShoppingLine("3 cups (360g) flour")).toEqual({
      qty: 3,
      unit: "cup",
      text: "flour"
    });
    expect(parseShoppingLine("2 garlic cloves, minced")).toEqual({
      qty: 2,
      unit: "clove",
      text: "garlic"
    });
    expect(parseShoppingLine("Salt to taste")).toEqual({ text: "Salt" });
    expect(parseShoppingLine("1 1/2 cups mixed berries, fresh or frozen")).toEqual({
      qty: 1.5,
      unit: "cup",
      text: "mixed berries"
    });
  });

  it("never produces a quantity or text the shopping contract rejects (bug 16)", () => {
    // "0-1 tsp" parses to {min: 0, max: 1}; the contract requires positive range ends.
    expect(parseShoppingLine("0-1 tsp salt")).toEqual({ qty: 1, unit: "tsp", text: "salt" });

    const long = parseShoppingLine(`2 cups ${"very ".repeat(100)}long flour`);
    expect(long.text.length).toBeLessThanOrEqual(MAX_SHOPPING_ITEM_TEXT_LENGTH);

    for (const line of ["0-1 tsp salt", `${"x".repeat(500)}`, "2 large eggs", "1-2 cans beans"]) {
      const parsed = parseShoppingLine(line);
      expect(
        shoppingItemSchema.safeParse({
          id: "item",
          addedBy: "user",
          checked: false,
          updatedAt: "2026-07-04T12:00:00.000Z",
          ...parsed
        }).success,
        line
      ).toBe(true);
    }
  });

  it("cleans names", () => {
    expect(cleanShoppingItemName("chickpeas, drained and rinsed")).toBe("chickpeas");
    expect(cleanShoppingItemName("walnuts (optional)")).toBe("walnuts");
    expect(cleanShoppingItemName("parmesan, for serving")).toBe("parmesan");
    expect(cleanShoppingItemName("black pepper to taste")).toBe("black pepper");
    expect(cleanShoppingItemName("(optional)")).toBe("(optional)");
    // Commas inside a parenthetical do not end the name; footnote marks are dropped.
    expect(cleanShoppingItemName("water (for a long period of simmering. If not, add less)")).toBe(
      "water"
    );
    expect(cleanShoppingItemName("milk, (skim, 1%, 2% or whole, your choice)*")).toBe("milk");
    expect(cleanShoppingItemName("semisweet chocolate chips*")).toBe("semisweet chocolate chips");
  });
});

describe("addShoppingQuantities (bug 17)", () => {
  it("never loses a quantity when adding a number and a range", () => {
    expect(addShoppingQuantities(2, { min: 1, max: 2 })).toEqual({ min: 3, max: 4 });
    expect(addShoppingQuantities({ min: 1, max: 2 }, 2)).toEqual({ min: 3, max: 4 });
    expect(addShoppingQuantities({ min: 1, max: 2 }, { min: 2, max: 3 })).toEqual({
      min: 3,
      max: 5
    });
    expect(addShoppingQuantities(1, 2)).toBe(3);
    expect(addShoppingQuantities(null, 2)).toBe(2);
    expect(addShoppingQuantities(2, undefined)).toBe(2);
    expect(addShoppingQuantities(undefined, undefined)).toBeUndefined();
  });
});

describe("addShoppingAmounts", () => {
  it("sums identical and differently spelled units", () => {
    expect(addShoppingAmounts({ qty: 1, unit: "cup" }, { qty: 2, unit: "cups" })).toEqual({
      qty: 3,
      unit: "cup"
    });
    expect(addShoppingAmounts({ qty: 2 }, { qty: { min: 1, max: 2 } })).toEqual({
      qty: { min: 3, max: 4 }
    });
  });

  it("sums compatible units in the larger one", () => {
    const spoons = addShoppingAmounts({ qty: 2, unit: "tsp" }, { qty: 1, unit: "Tbsp" });
    expect(spoons?.unit).toBe("Tbsp");
    expect(spoons?.qty).toBeCloseTo(5 / 3, 6);

    const milk = addShoppingAmounts({ qty: 1, unit: "cup" }, { qty: 250, unit: "ml" });
    expect(milk?.unit).toBe("cup");
    expect(milk?.qty).toBeCloseTo(2.057, 3);

    const small = addShoppingAmounts({ qty: 1, unit: "tsp" }, { qty: 1, unit: "tsp" });
    expect(small).toEqual({ qty: 2, unit: "tsp" });

    const grams = addShoppingAmounts({ qty: 100, unit: "g" }, { qty: 1, unit: "kg" });
    expect(grams?.unit).toBe("kg");
    expect(grams?.qty).toBeCloseTo(1.1, 6);

    const pinch = addShoppingAmounts({ qty: 0.25, unit: "tsp" }, { qty: 0.25, unit: "tsp" });
    expect(pinch).toEqual({ qty: 0.5, unit: "tsp" });
  });

  it("keeps the amount when one side has none", () => {
    expect(addShoppingAmounts({}, { qty: 1, unit: "tsp" })).toEqual({ qty: 1, unit: "tsp" });
    expect(addShoppingAmounts({ qty: 2, unit: "cup" }, {})).toEqual({ qty: 2, unit: "cup" });
    expect(addShoppingAmounts({}, {})).toEqual({});
  });

  it("refuses incompatible units", () => {
    expect(addShoppingAmounts({ qty: 2, unit: "cup" }, { qty: 100, unit: "g" })).toBeNull();
    expect(addShoppingAmounts({ qty: 1, unit: "cup" }, { qty: 1, unit: "can" })).toBeNull();
    expect(addShoppingAmounts({ qty: 2 }, { qty: 1, unit: "cup" })).toBeNull();
    expect(
      addShoppingAmounts({ qty: 2, unit: "tsp" }, { qty: 1, unit: "Tbsp" }, { convertUnits: false })
    ).toBeNull();
  });
});

describe("formatShoppingItemText (bug 18)", () => {
  it("prints friendly quantities instead of raw floats", () => {
    expect(formatShoppingItemText({ qty: 1 / 3, unit: "cup", text: "sugar" })).toBe("⅓ cup sugar");
    expect(formatShoppingItemText({ qty: 0.3333333333333333, unit: null, text: "lemon" })).toBe(
      "⅓ lemon"
    );
    expect(formatShoppingItemText({ qty: { min: 1.5, max: 3 }, unit: "cup", text: "milk" })).toBe(
      "1 ½–3 cups milk"
    );
    expect(formatShoppingItemText({ qty: 2, unit: "can", text: "chickpeas (15 oz)" })).toBe(
      "2 cans chickpeas (15 oz)"
    );
    expect(formatShoppingItemText({ qty: 2.057, unit: "cup", text: "milk" })).toBe("2 cups milk");
    expect(formatShoppingItemText({ text: "salt" })).toBe("salt");
  });
});

describe("mergeShoppingInputs", () => {
  it("merges the same item across recipes and keeps attribution", () => {
    const merged = mergeShoppingInputs([
      { text: "2 large eggs, beaten", recipeId: "r1", recipeTitle: "Pancakes", section: "Batter" },
      { text: "1 cup milk", recipeId: "r1", recipeTitle: "Pancakes" },
      { text: "1 egg", recipeId: "r2", recipeTitle: "Cookies" },
      { text: "250 ml milk", recipeId: "r2", recipeTitle: "Cookies" },
      { text: "Salt to taste", recipeId: "r2", recipeTitle: "Cookies" },
      { text: "1 tsp salt", recipeId: "r1", recipeTitle: "Pancakes" }
    ]);

    expect(merged.map((item) => formatShoppingItemText(item))).toEqual([
      "3 large eggs",
      "2 cups milk",
      "1 tsp salt"
    ]);
    expect(merged[0]).toMatchObject({
      key: "egg",
      category: "dairy-eggs",
      recipeIds: ["r1", "r2"],
      recipeTitles: ["Pancakes", "Cookies"],
      sections: ["Batter"],
      sourceTexts: ["2 large eggs, beaten", "1 egg"]
    });
    expect(merged[2]).toMatchObject({ qty: 1, unit: "tsp", recipeTitles: ["Cookies", "Pancakes"] });
  });

  it("re-inflects the name for the summed count", () => {
    const [eggs] = mergeShoppingInputs([{ text: "1 egg" }, { text: "2 eggs" }]);

    expect(eggs && formatShoppingItemText(eggs)).toBe("3 eggs");
  });

  it("keeps incompatible amounts of the same thing as separate entries", () => {
    const merged = mergeShoppingInputs([{ text: "2 cups flour" }, { text: "100 g flour" }]);

    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.key)).toEqual(["flour", "flour"]);
  });

  it("can merge only identical units", () => {
    expect(
      mergeShoppingInputs([{ text: "2 tsp sugar" }, { text: "1 Tbsp sugar" }], {
        convertUnits: false
      })
    ).toHaveLength(2);
    expect(mergeShoppingInputs([{ text: "2 tsp sugar" }, { text: "1 Tbsp sugar" }])).toHaveLength(
      1
    );
  });

  it("merges a whole starter recipe doubled into itself", () => {
    const recipe = SAMPLE_RECIPES[0].recipe;
    const inputs = recipeIngredientsToShoppingInputs(recipe, { recipeId: "r1" });
    const merged = mergeShoppingInputs([...inputs, ...inputs]);

    expect(merged).toHaveLength(recipe.ingredients.length);
    expect(merged.every((item) => item.recipeIds.length === 1)).toBe(true);
    expect(formatShoppingItemText(merged[0] ?? { text: "" })).toBe("6 Tbsp low-sodium soy sauce");
  });
});

describe("mergeShoppingItemLists", () => {
  type Item = {
    id: string;
    text: string;
    qty?: number | { min: number; max: number } | undefined;
    unit?: string | undefined;
    isDeleted?: boolean | undefined;
    mergedFrom?: string[] | undefined;
  };

  const combine = (
    existing: Item,
    incoming: Item,
    merged: { text: string; qty?: Item["qty"]; unit?: string | undefined }
  ): Item => ({
    ...existing,
    text: merged.text,
    qty: merged.qty,
    unit: merged.unit,
    mergedFrom: [...(existing.mergedFrom ?? [existing.id]), incoming.id]
  });

  it("merges into matching live items and appends the rest", () => {
    const result = mergeShoppingItemLists<Item>(
      [
        { id: "a", text: "sugar", qty: 1, unit: "cup" },
        { id: "b", text: "eggs", qty: 2, isDeleted: true }
      ],
      [
        { id: "c", text: "sugar", qty: 2, unit: "cups" },
        { id: "d", text: "large eggs", qty: 1 },
        { id: "e", text: "flour", qty: 100, unit: "g" }
      ],
      combine
    );

    expect(result).toEqual([
      { id: "a", text: "sugar", qty: 3, unit: "cup", mergedFrom: ["a", "c"] },
      { id: "b", text: "eggs", qty: 2, isDeleted: true },
      { id: "d", text: "large eggs", qty: 1 },
      { id: "e", text: "flour", qty: 100, unit: "g" }
    ]);
  });

  it("merges number and range quantities instead of dropping them (bug 17)", () => {
    const [eggs] = mergeShoppingItemLists<Item>(
      [{ id: "a", text: "egg", qty: 1 }],
      [{ id: "b", text: "eggs", qty: { min: 1, max: 2 } }],
      combine
    );

    expect(eggs).toMatchObject({ qty: { min: 2, max: 3 }, text: "eggs" });
  });

  it("finds the matching item index", () => {
    const items = [
      { text: "green onions", qty: 2 },
      { text: "milk", qty: 1, unit: "cup" }
    ];

    expect(findMergeableShoppingItem(items, { text: "scallions", qty: 1 })).toBe(0);
    expect(findMergeableShoppingItem(items, { text: "milk", qty: 100, unit: "ml" })).toBe(1);
    expect(findMergeableShoppingItem(items, { text: "milk", qty: 1, unit: "can" })).toBe(-1);
    expect(findMergeableShoppingItem(items, { text: "milk", isDeleted: true })).toBe(-1);
  });
});

describe("recipeIngredientsToShoppingInputs", () => {
  const recipe = SAMPLE_RECIPES[2].recipe;

  it("builds inputs with attribution, scale and selection", () => {
    const inputs = recipeIngredientsToShoppingInputs(recipe, {
      recipeId: "starter-pitas",
      scale: 2,
      selected: [0, 8]
    });

    expect(inputs).toEqual([
      {
        recipeId: "starter-pitas",
        recipeTitle: "Crisp Cucumber Chickpea Pitas",
        section: "For the filling",
        text: "2 cans chickpeas, drained and rinsed"
      },
      {
        recipeId: "starter-pitas",
        recipeTitle: "Crisp Cucumber Chickpea Pitas",
        section: "For serving",
        text: "4 pita pockets, halved"
      }
    ]);
  });

  it("keeps the written text when nothing changes and converts on request", () => {
    expect(recipeIngredientsToShoppingInputs(recipe, { selected: new Set([4]) })).toEqual([
      {
        recipeTitle: "Crisp Cucumber Chickpea Pitas",
        section: "For the dressing",
        text: "2 tablespoons plain Greek yogurt"
      }
    ]);
    expect(
      recipeIngredientsToShoppingInputs(recipe, {
        selected: (index) => index === 2,
        units: "metric"
      })[0]?.text
    ).toBe("240 ml cherry tomatoes, quartered");
  });
});
