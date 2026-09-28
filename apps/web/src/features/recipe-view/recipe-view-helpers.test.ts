import { describe, expect, it } from "vitest";

import {
  formatEditableIngredients,
  parseMinutesField,
  splitEditableIngredients
} from "./recipe-editing";
import { getRecipeSourceInfo, isImageImportSourceUrl } from "./recipe-source";
import {
  formatCompactDuration,
  formatCookedLine,
  formatRelativeDay,
  getRecipeMetaItems
} from "./recipe-view-format";
import { formatStepTimerLabel, getStepTimerSeconds } from "./step-timers";

const NOW = new Date("2026-09-28T12:00:00").getTime();
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("recipe editing text format", () => {
  it("reads '## Section' and legacy 'Section:' headings", () => {
    expect(
      splitEditableIngredients("## Dough\n2 cups flour\n\nFor the sauce:\n1 cup tomatoes\n")
    ).toEqual([
      { section: "Dough", text: "2 cups flour" },
      { section: "For the sauce", text: "1 cup tomatoes" }
    ]);
  });

  it("round-trips sections", () => {
    const ingredients = [
      { section: "Dough", text: "2 cups flour" },
      { section: "Dough", text: "1 tsp salt" },
      { section: "Topping", text: "Sugar" }
    ];
    const text = formatEditableIngredients(ingredients);

    expect(text).toBe("Dough:\n2 cups flour\n1 tsp salt\n\nTopping:\nSugar");
    expect(splitEditableIngredients(text)).toEqual(ingredients);
  });

  it("keeps '## ' for a section name that has its own colon", () => {
    const ingredients = [{ section: "Step 1: Dough", text: "2 cups flour" }];
    const text = formatEditableIngredients(ingredients);

    expect(text).toBe("## Step 1: Dough\n2 cups flour");
    expect(splitEditableIngredients(text)).toEqual(ingredients);
  });

  it("accepts whole minutes only", () => {
    expect(parseMinutesField("")).toBeNull();
    expect(parseMinutesField(" 45 ")).toBe(45);
    expect(parseMinutesField("1:30")).toBe("invalid");
    expect(parseMinutesField("-5")).toBe("invalid");
  });
});

describe("recipe source", () => {
  it("never links or shares photo imports", () => {
    const source = getRecipeSourceInfo("https://linkdish.app/image-imports/web-1-abc");

    expect(isImageImportSourceUrl("https://linkdish.app/image-imports/web-1-abc")).toBe(true);
    expect(source).toEqual({
      href: null,
      kind: "photos",
      label: "From your photos",
      shareUrl: null
    });
  });

  it("links real sources by hostname", () => {
    expect(getRecipeSourceInfo("https://www.seriouseats.com/best-chili")).toEqual({
      href: "https://www.seriouseats.com/best-chili",
      kind: "web",
      label: "seriouseats.com",
      shareUrl: "https://www.seriouseats.com/best-chili"
    });
  });

  it("does not link starter recipes or unparseable URLs", () => {
    expect(getRecipeSourceInfo("https://linkdish.ca/starter/pitas").href).toBeNull();
    expect(getRecipeSourceInfo("recipes/legacy", { sourceHost: "" })).toMatchObject({
      href: null,
      label: "unknown"
    });
  });
});

describe("recipe view formatting", () => {
  it("describes when a recipe was last cooked", () => {
    expect(formatRelativeDay(daysAgo(0), NOW)).toBe("today");
    expect(formatRelativeDay(daysAgo(1), NOW)).toBe("yesterday");
    expect(formatRelativeDay(daysAgo(15), NOW)).toBe("2 weeks ago");
    expect(formatCookedLine(3, daysAgo(15), NOW)).toBe("Cooked 3× · last 2 weeks ago");
    expect(formatCookedLine(1, daysAgo(9), NOW)).toBe("Cooked once · last week");
    expect(formatCookedLine(2, daysAgo(1), NOW)).toBe("Cooked 2× · yesterday");
    expect(formatCookedLine(0, undefined, NOW)).toBe("");
  });

  it("builds the meta strip from times and the scaled yield", () => {
    expect(
      getRecipeMetaItems({ cookTimeMinutes: 70, prepTimeMinutes: 20 }, "Serves 18 · 1 loaf")
    ).toEqual([
      { id: "total", label: "Total", spokenValue: "1 hr 30 min", value: "1h 30m" },
      { id: "prep", label: "Prep", value: "20 min" },
      { id: "cook", label: "Cook", spokenValue: "1 hr 10 min", value: "1h 10m" },
      { id: "serves", label: "Serves", value: "18" }
    ]);
    // The counted thing becomes the label, so the value is just the number.
    expect(
      getRecipeMetaItems({ cookTimeMinutes: null, prepTimeMinutes: 10 }, "24 cookies")
    ).toEqual([
      { id: "prep", label: "Prep", value: "10 min" },
      { id: "serves", label: "Cookies", spokenValue: "24 cookies", value: "24" }
    ]);
    expect(getRecipeMetaItems({ cookTimeMinutes: 120, prepTimeMinutes: null }, "Makes 12")).toEqual(
      [
        { id: "cook", label: "Cook", value: "2 hr" },
        { id: "serves", label: "Makes", value: "12" }
      ]
    );
    expect(
      getRecipeMetaItems({ cookTimeMinutes: null, prepTimeMinutes: null }, "9 small pancakes")
    ).toEqual([{ id: "serves", label: "Makes", spokenValue: "9 small pancakes", value: "9" }]);
  });

  it("keeps stat-strip durations short enough for one line", () => {
    expect(formatCompactDuration(45)).toBe("45 min");
    expect(formatCompactDuration(120)).toBe("2 hr");
    expect(formatCompactDuration(205)).toBe("3h 25m");
    expect(formatCompactDuration(1440)).toBe("1 day");
    expect(formatCompactDuration(1560)).toBe("1d 2h");
  });
});

describe("step timers", () => {
  it("labels chips with just the time and starts at the low end of a range", () => {
    expect(
      formatStepTimerLabel({
        label: "an additional 25 minutes",
        maxSeconds: 1500,
        minSeconds: 1500
      })
    ).toBe("25 min");
    expect(
      formatStepTimerLabel({ label: "30 to 35 minutes", maxSeconds: 2100, minSeconds: 1800 })
    ).toBe("30–35 min");
    expect(
      formatStepTimerLabel({ label: "1 to 2 hours", maxSeconds: 7200, minSeconds: 3600 })
    ).toBe("1–2 hr");
    expect(formatStepTimerLabel({ label: "90 minutes", maxSeconds: 5400, minSeconds: 5400 })).toBe(
      "1 hr 30 min"
    );
    expect(formatStepTimerLabel({ label: "30 seconds", maxSeconds: 30, minSeconds: 30 })).toBe(
      "30 sec"
    );
    expect(
      getStepTimerSeconds({ label: "30 to 35 minutes", maxSeconds: 2100, minSeconds: 1800 })
    ).toBe(1800);
  });
});
