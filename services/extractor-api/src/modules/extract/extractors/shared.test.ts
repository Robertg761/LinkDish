import { describe, expect, it } from "vitest";

import { parseServingsText, toIngredientLines, toStepLines } from "./shared";

describe("toIngredientLines", () => {
  it("collapses duplicated parenthetical notes from malformed ingredient strings", () => {
    expect(toIngredientLines(["2 tsp garam masala ((Note 1))"])).toEqual([
      { text: "2 tsp garam masala (Note 1)" }
    ]);
  });

  it("flattens malformed comma-prefixed parenthetical notes", () => {
    expect(toIngredientLines(["1/2 cup plain yoghurt (, full fat)"])).toEqual([
      { text: "1/2 cup plain yoghurt, full fat" }
    ]);
  });

  it("preserves valid parenthetical measurements and notes", () => {
    expect(
      toIngredientLines([
        "1 (14-ounce) can crushed tomatoes",
        "4 cups (520g) bread flour (spooned & leveled)"
      ])
    ).toEqual([
      { text: "1 (14-ounce) can crushed tomatoes" },
      { text: "4 cups (520g) bread flour (spooned & leveled)" }
    ]);
  });
});

describe("parseServingsText", () => {
  it("normalizes non-string structured data values", () => {
    expect(parseServingsText(12)).toBe("12");
    expect(parseServingsText(true)).toBe("true");
  });

  it("ignores structured data values that cannot be represented as servings text", () => {
    expect(parseServingsText(null)).toBeNull();
    expect(parseServingsText(undefined)).toBeNull();
    expect(parseServingsText(["12 servings"])).toBeNull();
    expect(parseServingsText({ value: "12 servings" })).toBeNull();
  });
});

describe("toStepLines", () => {
  it("splits schema instructions that collapse multiple numbered steps into one value", () => {
    expect(
      toStepLines([
        "Heat the oil.",
        "2. Add the onion and cook until softened. 3. Stir in the spices. 4. Add the tomatoes and simmer."
      ])
    ).toEqual([
      { index: 1, text: "Heat the oil." },
      { index: 2, text: "Add the onion and cook until softened." },
      { index: 3, text: "Stir in the spices." },
      { index: 4, text: "Add the tomatoes and simmer." }
    ]);
  });

  it("splits newline-separated steps from nested recipe sections", () => {
    expect(
      toStepLines(["Prepare the sauce.\nCook the pasta until al dente.\nToss everything together."])
    ).toEqual([
      { index: 1, text: "Prepare the sauce." },
      { index: 2, text: "Cook the pasta until al dente." },
      { index: 3, text: "Toss everything together." }
    ]);
  });
});
