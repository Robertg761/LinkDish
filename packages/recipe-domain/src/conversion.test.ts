import { describe, expect, it } from "vitest";

import {
  convertIngredientLine,
  convertParsedQuantity,
  convertTemperaturesInText,
  findIngredientDensity,
  formatIngredientQuantity,
  formatQuantity,
  getDisplayIngredient,
  getDisplayIngredientText,
  getIngredientUnitSummary,
  parseIngredientQuantity,
  SAMPLE_RECIPES,
  scaleQuantity
} from "./index.js";

describe("formatQuantity", () => {
  const corpus: ReadonlyArray<readonly [Parameters<typeof formatQuantity>[0], string]> = [
    [2 / 3, "⅔"],
    [0.6666666666666666, "⅔"],
    [1 / 3, "⅓"],
    [0.125, "⅛"],
    [0.25, "¼"],
    [0.5, "½"],
    [0.75, "¾"],
    [1.5, "1 ½"],
    [2.375, "2 ⅜"],
    [3, "3"],
    [0.1 + 0.2, "0.3"],
    [0.06, "0.06"],
    [250, "250"],
    [{ min: 1, max: 2 }, "1–2"],
    [{ min: 0.25, max: 0.5 }, "¼–½"],
    [{ min: 2, max: 1 }, "1–2"],
    [{ min: 2, max: 2 }, "2"],
    [null, ""],
    [undefined, ""],
    [Number.NaN, ""],
    [-1, ""]
  ];

  it("prints friendly fractions and en-dash ranges without float noise", () => {
    expect(corpus).toHaveLength(21);

    for (const [value, expected] of corpus) {
      expect(formatQuantity(value), JSON.stringify(value)).toBe(expected);
    }
  });

  it("can print decimals instead", () => {
    expect(formatQuantity(2 / 3, { style: "decimal" })).toBe("0.67");
    expect(formatQuantity(1.5, { style: "decimal" })).toBe("1.5");
  });
});

describe("formatIngredientQuantity", () => {
  it("pluralizes the unit from the printed amount", () => {
    expect(formatIngredientQuantity(2, "cup")).toBe("2 cups");
    expect(formatIngredientQuantity(1, "cup")).toBe("1 cup");
    expect(formatIngredientQuantity(0.5, "cup")).toBe("½ cup");
    expect(formatIngredientQuantity(1.02, "cup")).toBe("1 cup");
    expect(formatIngredientQuantity(1 / 3, "cup")).toBe("⅓ cup");
    expect(formatIngredientQuantity({ min: 1, max: 2 }, "cup")).toBe("1–2 cups");
    expect(formatIngredientQuantity(1.5, "Tbsp")).toBe("1 ½ Tbsp");
    expect(formatIngredientQuantity(250, "g")).toBe("250 g");
    expect(formatIngredientQuantity(3, "clove")).toBe("3 cloves");
    expect(formatIngredientQuantity(1, "can")).toBe("1 can");
    expect(formatIngredientQuantity(2, "tablespoons")).toBe("2 Tbsp");
    expect(formatIngredientQuantity(2, "bottle")).toBe("2 bottles");
    expect(formatIngredientQuantity(3, null)).toBe("3");
    expect(formatIngredientQuantity(null, "cup")).toBe("");
  });

  it("can round whole items the way scaling does", () => {
    expect(formatIngredientQuantity(1.5, "can")).toBe("1 ½ cans");
    expect(formatIngredientQuantity(1.5, "can", { wholeItems: "range" })).toBe("1–2 cans");
    expect(formatIngredientQuantity(4 / 3, null, { wholeItems: "range" })).toBe("1–2");
  });
});

describe("convertIngredientLine to metric", () => {
  const corpus: ReadonlyArray<readonly [string, string, boolean]> = [
    ["2 cups all-purpose flour", "240 g all-purpose flour", true],
    ["1 cup sugar", "200 g sugar", true],
    ["3/4 cup packed brown sugar", "160 g packed brown sugar", true],
    ["1/2 cup butter, softened", "110 g butter, softened", true],
    ["1 1/2 cups rolled oats", "140 g rolled oats", true],
    ["1 cup uncooked rice", "190 g uncooked rice", true],
    ["1/4 cup honey", "85 g honey", true],
    ["1 cup milk", "240 ml milk", false],
    ["1/4 cup olive oil", "60 ml olive oil", false],
    ["1 cup water", "240 ml water", false],
    ["2 quarts chicken stock", "1.89 l chicken stock", false],
    ["1/2 cup rice vinegar", "120 ml rice vinegar", false],
    ["2 cups sugar snap peas", "470 ml sugar snap peas", false],
    ["3 cups cooked jasmine rice", "710 ml cooked jasmine rice", false],
    ["1 lb ground beef", "450 g ground beef", false],
    ["8 oz cream cheese", "230 g cream cheese", false],
    ["24 oz pasta", "680 g pasta", false],
    ["1 stick butter", "110 g butter", false],
    ["1 teaspoon vanilla", "1 tsp vanilla", false],
    ["3 teaspoons baking powder", "1 Tbsp baking powder", false],
    ["2 tablespoons honey", "2 Tbsp honey", false],
    ["250 g flour", "250 g flour", false],
    ["1000 g potatoes", "1 kg potatoes", false],
    ["2 cups [280 g] all-purpose flour", "280 g all-purpose flour", false],
    ["3 cups (360g) flour", "360 g flour", false],
    ["2 tablespoons (25g) granulated sugar", "25 g granulated sugar", false],
    ["1 (15-ounce) can chickpeas", "1 (425 g) can chickpeas", false],
    ["2 (28 oz) cans tomatoes", "2 (794 g) cans tomatoes", false],
    ["2 large eggs", "2 large eggs", false],
    ["3 cloves garlic", "3 cloves garlic", false],
    ["1 pinch salt", "1 pinch salt", false],
    ["4 chicken breasts (about 2 lbs)", "4 chicken breasts (about 910 g)", false],
    ["Salt to taste", "Salt to taste", false]
  ];

  it("converts the labelled corpus", () => {
    expect(corpus).toHaveLength(33);

    for (const [text, expected, approximate] of corpus) {
      const converted = convertIngredientLine(text, "metric");
      expect(converted.text, text).toBe(expected);
      expect(converted.approximate, `${text} approximate`).toBe(approximate);
    }
  });

  it("scales before converting", () => {
    expect(convertIngredientLine("2 cups flour", "metric", { scale: 0.5 }).text).toBe(
      "120 g flour"
    );
    expect(convertIngredientLine("1 lb ground beef", "metric", { scale: 2 }).text).toBe(
      "910 g ground beef"
    );
    expect(convertIngredientLine("600 g potatoes", "metric", { scale: 2 }).text).toBe(
      "1.2 kg potatoes"
    );
    expect(convertIngredientLine("2 large eggs", "metric", { scale: 0.5 }).text).toBe(
      "1 large egg"
    );
  });

  it("can skip the density table", () => {
    expect(convertIngredientLine("2 cups flour", "metric", { useDensity: false })).toMatchObject({
      text: "470 ml flour",
      approximate: false
    });
  });

  it("keeps an alternate that follows another amount as that amount's alternate", () => {
    expect(
      convertIngredientLine(
        "4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil",
        "metric"
      ).text
    ).toBe("57 g melted butter or 60 ml (50g) vegetable oil");
  });
});

describe("convertIngredientLine to US", () => {
  const corpus: ReadonlyArray<readonly [string, string]> = [
    ["250 g flour", "9 oz flour"],
    ["450 g beef", "1 lb beef"],
    ["1 kg chicken thighs", "2 ¼ lb chicken thighs"],
    ["200g dark chocolate", "7 oz dark chocolate"],
    ["500 ml stock", "2 ⅛ cups stock"],
    ["1.5 l water", "6 ⅓ cups water"],
    ["5 ml vanilla", "1 tsp vanilla"],
    ["15 ml soy sauce", "1 Tbsp soy sauce"],
    ["60 ml cream", "¼ cup cream"],
    ["3 teaspoons baking powder", "1 Tbsp baking powder"],
    ["16 tablespoons butter", "1 cup butter"],
    ["8 tablespoons butter", "8 Tbsp butter"],
    ["0.25 lb bacon", "4 oz bacon"],
    ["24 oz pasta", "1 ½ lb pasta"],
    ["2 cups flour", "2 cups flour"],
    ["2 x 400g tins chopped tomatoes", "2 x 14 oz tins chopped tomatoes"],
    ["280 g [2 cups] flour", "2 cups flour"],
    ["3 cups (360g) flour", "3 cups (360 g) flour"],
    ["2 large eggs", "2 large eggs"]
  ];

  it("converts the labelled corpus", () => {
    expect(corpus).toHaveLength(19);

    for (const [text, expected] of corpus) {
      expect(convertIngredientLine(text, "us").text, text).toBe(expected);
    }
  });

  it("promotes and demotes units after scaling", () => {
    expect(convertIngredientLine("1 cup flour", "us", { scale: 0.25 }).text).toBe("4 Tbsp flour");
    expect(convertIngredientLine("1 Tbsp oil", "us", { scale: 0.5 }).text).toBe("1 ½ tsp oil");
    expect(convertIngredientLine("1 tsp salt", "us", { scale: 3 }).text).toBe("1 Tbsp salt");
    expect(convertIngredientLine("8 Tbsp butter", "us", { scale: 2 }).text).toBe("1 cup butter");
    expect(convertIngredientLine("1 lb beef", "us", { scale: 0.25 }).text).toBe("4 oz beef");
    expect(convertIngredientLine("1 cup milk", "us", { scale: 0.3 }).text).toBe("⅓ cup milk");
  });

  it("can use the density table in reverse", () => {
    expect(convertIngredientLine("240 g flour", "us", { useDensity: true })).toMatchObject({
      text: "2 cups flour",
      approximate: true
    });
  });
});

describe("conversion invariants", () => {
  const inputs = [
    "2 cups all-purpose flour",
    "1/2 cup butter",
    "1 lb ground beef",
    "250 g flour",
    "1.5 l water",
    "3 cups (360g) flour",
    "1 (15-ounce) can chickpeas",
    "2 large eggs, beaten",
    "1/2 to 2/3 cup (113g to 152g) hot water",
    "2-3 Tbsp lemon juice",
    "1 stick butter",
    "4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil"
  ];
  const factors = [0.25, 0.5, 1, 1.5, 2, 3];

  it("re-parses every converted line confidently and never prints float noise", () => {
    for (const input of inputs) {
      for (const target of ["us", "metric"] as const) {
        for (const scale of factors) {
          const { text } = convertIngredientLine(input, target, { scale });
          const context = `${input} -> ${target} x${scale}: ${text}`;

          expect(parseIngredientQuantity(text).confident, context).toBe(true);
          expect(text, context).not.toMatch(/\d\.\d{3,}|e[+-]\d|NaN|Infinity/);
        }
      }
    }
  });

  it("reports whether anything changed", () => {
    expect(convertIngredientLine("2 cups flour", "us").converted).toBe(false);
    expect(convertIngredientLine("2 cups flour", "metric").converted).toBe(true);
    expect(convertIngredientLine("Salt to taste", "metric")).toMatchObject({
      text: "Salt to taste",
      confident: false,
      converted: false
    });
    expect(convertParsedQuantity(parseIngredientQuantity("2 eggs"), "metric").converted).toBe(
      false
    );
  });

  it("matches density entries conservatively", () => {
    expect(findIngredientDensity("all-purpose flour")?.key).toBe("flour");
    expect(findIngredientDensity("flour tortillas")).toBeNull();
    expect(findIngredientDensity("sugar snap peas")).toBeNull();
    expect(findIngredientDensity("butter beans")).toBeNull();
    expect(findIngredientDensity("peanut butter")?.key).toBe("nut-butter");
    expect(findIngredientDensity("buttermilk")?.key).toBe("buttermilk");
    expect(findIngredientDensity("rice vinegar")).toBeNull();
    expect(findIngredientDensity("cooked rice")).toBeNull();
    expect(findIngredientDensity("water chestnuts")).toBeNull();
    expect(findIngredientDensity("milk chocolate")).toBeNull();
  });
});

describe("getDisplayIngredient", () => {
  // The web cook mode's former getScaledIngredientText: parse, then scaleQuantity unless the
  // line has no amount. Units "original" must stay byte-for-byte identical to it.
  const legacyScaledText = (text: string, factor: number): string => {
    const parsed = parseIngredientQuantity(text);
    return parsed.confident ? scaleQuantity(parsed, factor) : text;
  };
  const legacyAlternateText = (text: string, factor: number): string => {
    const parsed = parseIngredientQuantity(text);

    if (!parsed.confident) {
      return text;
    }

    return parsed.altQty != null && parsed.altUnit
      ? scaleQuantity(
          { ...parsed, qty: parsed.altQty, unit: parsed.altUnit, altQty: null, altUnit: null },
          factor
        )
      : scaleQuantity(parsed, factor);
  };
  const lines = [
    ...SAMPLE_RECIPES.flatMap((sample) =>
      sample.recipe.ingredients.map((ingredient) => ingredient.text)
    ),
    "2 cups [280 g] all-purpose flour",
    "3 cups (360g) flour",
    "Salt to taste",
    "1 (15-ounce) can chickpeas"
  ];

  it("keeps the original-units output identical to the cook mode's", () => {
    for (const text of lines) {
      for (const scale of [0.5, 1, 2, 3]) {
        expect(getDisplayIngredientText(text, { scale }), `${text} x${scale}`).toBe(
          legacyScaledText(text, scale)
        );
      }
    }
  });

  it("covers the bracketed-alternate toggle when the alternate is in the chosen system", () => {
    for (const scale of [0.5, 1, 2]) {
      expect(
        getDisplayIngredientText("2 cups [280 g] all-purpose flour", { scale, units: "metric" })
      ).toBe(legacyAlternateText("2 cups [280 g] all-purpose flour", scale));
    }
  });

  it("reports flags", () => {
    expect(getDisplayIngredient("2 cups flour", { units: "metric", scale: 0.5 })).toEqual({
      text: "120 g flour",
      confident: true,
      scaled: true,
      converted: true,
      approximate: true
    });
    expect(getDisplayIngredient("Pepper to taste", { scale: 2 })).toEqual({
      text: "Pepper to taste",
      confident: false,
      scaled: false,
      converted: false,
      approximate: false
    });
  });

  it("can keep the text as written when nothing changes", () => {
    expect(getDisplayIngredientText("3 tablespoons soy sauce")).toBe("3 Tbsp soy sauce");
    expect(getDisplayIngredientText("3 tablespoons soy sauce", { keepOriginalText: true })).toBe(
      "3 tablespoons soy sauce"
    );
    expect(
      getDisplayIngredientText("3 tablespoons soy sauce", { keepOriginalText: true, scale: 2 })
    ).toBe("6 Tbsp soy sauce");
  });
});

describe("getIngredientUnitSummary", () => {
  it("summarizes the systems and flags a recipe uses", () => {
    expect(
      getIngredientUnitSummary([
        "2 cups flour",
        { text: "1 tsp salt" },
        "200 g butter",
        "3 cups (360g) flour",
        "Pepper to taste",
        "2 eggs"
      ])
    ).toEqual({
      usLines: 3,
      metricLines: 1,
      primarySystem: "us",
      hasAlternateAmounts: true,
      hasUnscalableLines: true,
      canConvert: true
    });
    expect(getIngredientUnitSummary(["2 eggs"]).primarySystem).toBeNull();
  });
});

describe("convertTemperaturesInText", () => {
  const corpus: ReadonlyArray<readonly [string, string, string]> = [
    ["Preheat the oven to 350°F.", "Preheat the oven to 175°C.", "Preheat the oven to 350°F."],
    [
      "Heat the oven to 350 F and line a pan.",
      "Heat the oven to 175°C and line a pan.",
      "Heat the oven to 350 F and line a pan."
    ],
    ["Bake at 350 degrees F.", "Bake at 175°C.", "Bake at 350 degrees F."],
    ["Bake at 350 degrees Fahrenheit.", "Bake at 175°C.", "Bake at 350 degrees Fahrenheit."],
    ["Set the oven to 180 C.", "Set the oven to 180 C.", "Set the oven to 350°F."],
    [
      "Bake at 200°C/180°C fan/gas mark 6.",
      "Bake at 200°C/180°C fan/gas mark 6.",
      "Bake at 400°F/350°F fan/gas mark 6."
    ],
    ["Preheat oven to 350°F (175°C).", "Preheat oven to 175°C.", "Preheat oven to 350°F."],
    [
      "Bake at 180°C (350°F) for 20 minutes.",
      "Bake at 180°C for 20 minutes.",
      "Bake at 350°F for 20 minutes."
    ],
    ["Roast at 375-400°F.", "Roast at 190–205°C.", "Roast at 375-400°F."],
    [
      "Cook until it registers 165°F.",
      "Cook until it registers 74°C.",
      "Cook until it registers 165°F."
    ],
    ["Heat to 240°F (soft ball).", "Heat to 116°C (soft ball).", "Heat to 240°F (soft ball)."],
    ["Chill to 4°C.", "Chill to 4°C.", "Chill to 39°F."],
    ["Freeze at -18°C.", "Freeze at -18°C.", "Freeze at 0°F."],
    [
      "Bake at 425 degrees until crisp.",
      "Bake at 425 degrees until crisp.",
      "Bake at 425 degrees until crisp."
    ],
    ["Bake at gas mark 4.", "Bake at gas mark 4.", "Bake at gas mark 4."],
    ["Add 12 C flour.", "Add 12 C flour.", "Add 12 C flour."],
    ["Use an 8-inch pan.", "Use an 8-inch pan.", "Use an 8-inch pan."]
  ];

  it("converts oven and food temperatures both ways", () => {
    expect(corpus).toHaveLength(17);

    for (const [text, metric, us] of corpus) {
      expect(convertTemperaturesInText(text, "metric"), text).toBe(metric);
      expect(convertTemperaturesInText(text, "us"), text).toBe(us);
    }
  });

  it("round-trips common oven temperatures", () => {
    for (const fahrenheit of [300, 325, 350, 375, 400, 425, 450]) {
      const celsius = convertTemperaturesInText(`${fahrenheit}°F`, "metric");
      expect(convertTemperaturesInText(celsius, "us")).toBe(`${fahrenheit}°F`);
    }
  });
});

describe("compound amounts in conversion (bug 16)", () => {
  it("converts '1 cup plus 2 tablespoons' as one amount", () => {
    expect(convertIngredientLine("1 cup plus 2 tablespoons flour", "metric").text).toBe(
      "140 g flour"
    );
    expect(convertIngredientLine("1 cup plus 2 tablespoons flour", "us", { scale: 2 }).text).toBe(
      "2 ¼ cups flour"
    );
    expect(convertIngredientLine("1 cup plus 2 tablespoons (140g) flour", "metric").text).toBe(
      "140 g flour"
    );
  });

  it("keeps a metric alternate when a US amount only moves to a smaller US unit", () => {
    expect(convertIngredientLine("1/2 cup (113g) milk", "us", { scale: 0.5 }).text).toBe(
      "4 Tbsp (57 g) milk"
    );
  });

  it("keeps the compound as written when nothing needs converting", () => {
    expect(convertIngredientLine("1 cup plus 2 tablespoons flour", "us").text).toBe(
      "1 cup plus 2 Tbsp flour"
    );
  });
});
