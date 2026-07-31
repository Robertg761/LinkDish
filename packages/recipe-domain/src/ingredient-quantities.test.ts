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
