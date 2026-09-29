import { describe, expect, it } from "vitest";

import {
  formatDuration,
  formatServings,
  getRecipeTimes,
  parseDuration,
  parseServings,
  SAMPLE_RECIPES,
  scaleFactorForServings
} from "./index.js";

describe("parseServings", () => {
  const corpus: ReadonlyArray<{
    text: string;
    min: number;
    max: number;
    kind: "servings" | "items";
    display: string;
  }> = [
    { text: "4 servings", min: 4, max: 4, kind: "servings", display: "Serves 4" },
    { text: "4-6 servings", min: 4, max: 6, kind: "servings", display: "Serves 4–6" },
    { text: "6 serving(s)", min: 6, max: 6, kind: "servings", display: "Serves 6" },
    { text: "Serves 4", min: 4, max: 4, kind: "servings", display: "Serves 4" },
    { text: "Serves 4 to 6", min: 4, max: 6, kind: "servings", display: "Serves 4–6" },
    { text: "Serves four", min: 4, max: 4, kind: "servings", display: "Serves 4" },
    { text: "Serves: 8 people", min: 8, max: 8, kind: "servings", display: "Serves 8" },
    { text: "8", min: 8, max: 8, kind: "servings", display: "Serves 8" },
    { text: "Makes 12 cookies", min: 12, max: 12, kind: "items", display: "12 cookies" },
    { text: "9 bars", min: 9, max: 9, kind: "items", display: "9 bars" },
    { text: "9 small pancakes", min: 9, max: 9, kind: "items", display: "9 small pancakes" },
    { text: "4 pita halves", min: 4, max: 4, kind: "items", display: "4 pita halves" },
    { text: "Yield: 24 muffins", min: 24, max: 24, kind: "items", display: "24 muffins" },
    { text: "2 dozen cookies", min: 24, max: 24, kind: "items", display: "24 cookies" },
    { text: "Makes 2 dozen", min: 24, max: 24, kind: "items", display: "Makes 24" },
    { text: "12 to 16 cookies", min: 12, max: 16, kind: "items", display: "12–16 cookies" },
    { text: "1 loaf", min: 1, max: 1, kind: "items", display: "1 loaf" },
    { text: "16, 1 loaf", min: 16, max: 16, kind: "servings", display: "Serves 16 · 1 loaf" },
    { text: "18, 1 loaf", min: 18, max: 18, kind: "servings", display: "Serves 18 · 1 loaf" },
    { text: "36, 36 cookies", min: 36, max: 36, kind: "items", display: "36 cookies" },
    {
      text: "12, 1 or 2 standard round pizzas, or 1 large rectangular pizza, about 12 servings",
      min: 12,
      max: 12,
      kind: "servings",
      display: "Serves 12"
    },
    {
      text: "4 quarts, 10-14 serving(s)",
      min: 10,
      max: 14,
      kind: "servings",
      display: "Serves 10–14 · 4 quarts"
    },
    {
      text: "4 servings (about 1 cup each)",
      min: 4,
      max: 4,
      kind: "servings",
      display: "Serves 4"
    },
    {
      text: "Serves 4 as a main, 6 as a side",
      min: 4,
      max: 4,
      kind: "servings",
      display: "Serves 4"
    }
  ];

  it("parses the labelled corpus", () => {
    expect(corpus).toHaveLength(24);

    for (const { text, ...expected } of corpus) {
      expect(parseServings(text), text).toMatchObject(expected);
    }
  });

  it("returns null without a usable count", () => {
    for (const text of ["", "   ", "Varies", "a crowd", null, undefined]) {
      expect(parseServings(text), String(text)).toBeNull();
    }
  });

  it("keeps the side yield and noun as data", () => {
    expect(parseServings("16, 1 loaf")).toEqual({
      min: 16,
      max: 16,
      kind: "servings",
      yield: "1 loaf",
      display: "Serves 16 · 1 loaf"
    });
    expect(parseServings("Makes 12 cookies")?.noun).toBe("cookies");
  });

  it("reads every starter recipe", () => {
    expect(SAMPLE_RECIPES.map((sample) => parseServings(sample.recipe.servings)?.display)).toEqual([
      "Serves 4",
      "9 bars",
      "4 pita halves"
    ]);
  });
});

describe("formatServings and scaleFactorForServings", () => {
  it("formats scaled servings", () => {
    expect(formatServings("4 servings")).toBe("Serves 4");
    expect(formatServings("4 servings", { scale: 2 })).toBe("Serves 8");
    expect(formatServings("Makes 12 cookies", { scale: 0.5 })).toBe("6 cookies");
    expect(formatServings("16, 1 loaf", { scale: 2 })).toBe("Serves 32");
    expect(formatServings("Serves 4-6", { scale: 1.5 })).toBe("Serves 6–9");
    expect(formatServings("Varies")).toBe("Varies");
    expect(formatServings(null)).toBe("");
  });

  it("scales from the low end of a range", () => {
    expect(scaleFactorForServings("4 servings", 8)).toBe(2);
    expect(scaleFactorForServings("Serves 4-6", 2)).toBe(0.5);
    expect(scaleFactorForServings(parseServings("Makes 12 cookies"), 36)).toBe(3);
    expect(scaleFactorForServings("Varies", 4)).toBe(1);
    expect(scaleFactorForServings("4 servings", 0)).toBe(1);
    expect(scaleFactorForServings("4 servings", Number.NaN)).toBe(1);
  });
});

describe("parseDuration", () => {
  const corpus: ReadonlyArray<readonly [string | number | null, number | null]> = [
    ["PT1H30M", 90],
    ["P0DT0H45M", 45],
    ["PT45M", 45],
    ["PT1H", 60],
    ["pt20m", 20],
    ["PT0.5H", 30],
    ["PT90S", 2],
    ["P1D", 1440],
    ["P0D", 0],
    ["PT", null],
    ["P", null],
    ["1 hour 30 minutes", 90],
    ["1 hr 30 min", 90],
    ["1½ hours", 90],
    ["1-1/2 hours", 90],
    ["45 min", 45],
    ["10-15 minutes", 15],
    ["Prep 10 min, cook 20 min", 30],
    ["1:30", 90],
    ["90", 90],
    [25, 25],
    ["overnight", null],
    ["", null],
    [null, null],
    [-5, null]
  ];

  it("reads ISO 8601 and free-text durations", () => {
    expect(corpus).toHaveLength(25);

    for (const [value, expected] of corpus) {
      expect(parseDuration(value), String(value)).toBe(expected);
    }
  });
});

describe("formatDuration", () => {
  it("prints recipe-card durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(90)).toBe("1 hr 30 min");
    expect(formatDuration(180)).toBe("3 hr");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(1500)).toBe("1 day 1 hr");
    expect(formatDuration(89.6)).toBe("1 hr 30 min");
    expect(formatDuration(90, { style: "long" })).toBe("1 hour 30 minutes");
    expect(formatDuration(61, { style: "long" })).toBe("1 hour 1 minute");
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-1)).toBe("");
  });
});

describe("getRecipeTimes", () => {
  it("adds prep and cook when the recipe has no total", () => {
    expect(getRecipeTimes({ prepTimeMinutes: 15, cookTimeMinutes: 38 })).toEqual({
      prep: 15,
      cook: 38,
      total: 53,
      labels: { prep: "15 min", cook: "38 min", total: "53 min" },
      display: "Prep 15 min · Cook 38 min · Total 53 min"
    });
  });

  it("prefers the recipe's own total, which can include resting time", () => {
    expect(
      getRecipeTimes({ prepTimeMinutes: 20, cookTimeMinutes: 35, totalTimeMinutes: 180 }).display
    ).toBe("Prep 20 min · Cook 35 min · Total 3 hr");
  });

  it("drops zero and unknown parts from the summary", () => {
    expect(getRecipeTimes({ prepTimeMinutes: 12, cookTimeMinutes: 0 }).display).toBe(
      "Prep 12 min · Total 12 min"
    );
    expect(getRecipeTimes({ prepTimeMinutes: null, cookTimeMinutes: null })).toMatchObject({
      total: null,
      display: ""
    });
  });

  it("reads every starter recipe", () => {
    expect(SAMPLE_RECIPES.map((sample) => getRecipeTimes(sample.recipe).total)).toEqual([
      30, 53, 12
    ]);
  });
});
