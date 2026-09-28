import { describe, expect, it } from "vitest";

import { getSortDirectionLabel, sortCookbookRecords } from "./cookbookSort";

const record = (
  title: string,
  savedAt: string,
  times: { cook?: number | null; prep?: number | null; total?: number | null } = {},
  timesCooked = 0
) => ({
  recipe: {
    cookTimeMinutes: times.cook ?? null,
    prepTimeMinutes: times.prep ?? null,
    title,
    totalTimeMinutes: times.total ?? null
  },
  savedAt,
  timesCooked
});

const accessors = {
  getSavedAt: (entry: ReturnType<typeof record>) => entry.savedAt,
  getTimesCooked: (entry: ReturnType<typeof record>) => entry.timesCooked
};

const titles = (records: Array<ReturnType<typeof record>>) =>
  records.map((entry) => entry.recipe.title);

describe("sortCookbookRecords", () => {
  const stew = record("Stew", "2026-07-01T00:00:00.000Z", { cook: 180, prep: 20 }, 1);
  const salad = record("Salad", "2026-07-03T00:00:00.000Z", { prep: 10 }, 4);
  const toast = record("Toast", "2026-07-02T00:00:00.000Z", {}, 0);
  const bread = record("Bread", "2026-06-30T00:00:00.000Z", { prep: 30, total: 240 }, 2);
  const all = [stew, salad, toast, bread];

  it("sorts by the quickest total time and keeps untimed recipes last", () => {
    expect(titles(sortCookbookRecords(all, "quickest", "forward", accessors))).toEqual([
      "Salad",
      "Stew",
      "Bread",
      "Toast"
    ]);
    expect(titles(sortCookbookRecords(all, "quickest", "reverse", accessors))).toEqual([
      "Bread",
      "Stew",
      "Salad",
      "Toast"
    ]);
    expect(getSortDirectionLabel("quickest", "forward")).toBe("Quickest first");
  });

  it("sorts by recency, title and times cooked", () => {
    expect(titles(sortCookbookRecords(all, "recent", "forward", accessors))).toEqual([
      "Salad",
      "Toast",
      "Stew",
      "Bread"
    ]);
    expect(titles(sortCookbookRecords(all, "az", "reverse", accessors))).toEqual([
      "Toast",
      "Stew",
      "Salad",
      "Bread"
    ]);
    expect(titles(sortCookbookRecords(all, "mostCooked", "forward", accessors))).toEqual([
      "Salad",
      "Bread",
      "Stew",
      "Toast"
    ]);
  });

  it("does not mutate its input", () => {
    const input = [...all];
    sortCookbookRecords(input, "az", "reverse", accessors);

    expect(input).toEqual(all);
  });
});
