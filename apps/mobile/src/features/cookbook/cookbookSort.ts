import { getRecipeTimes } from "@linkdish/recipe-domain";
import { decodeHtmlEntities } from "@linkdish/utils";

import type { Recipe } from "@linkdish/recipe-domain";

export type CookbookSort = "recent" | "az" | "mostCooked" | "quickest";
export type CookbookSortDirection = "forward" | "reverse";

export const COOKBOOK_SORT_OPTIONS: ReadonlyArray<{
  label: string;
  personalOnly: boolean;
  value: CookbookSort;
}> = [
  { label: "Recent", personalOnly: false, value: "recent" },
  { label: "A–Z", personalOnly: false, value: "az" },
  { label: "Most cooked", personalOnly: true, value: "mostCooked" },
  { label: "Quickest", personalOnly: false, value: "quickest" }
];

export const isCookbookSort = (value: string | null): value is CookbookSort =>
  COOKBOOK_SORT_OPTIONS.some((option) => option.value === value);

export const isCookbookSortDirection = (value: string | null): value is CookbookSortDirection =>
  value === "forward" || value === "reverse";

const NBSP_PATTERN = /\u00a0/gu;

export const normalizeRecipeText = (value: string) =>
  decodeHtmlEntities(value).replace(NBSP_PATTERN, " ");

type SortableRecord = {
  recipe: Pick<Recipe, "cookTimeMinutes" | "prepTimeMinutes" | "title"> & {
    totalTimeMinutes?: number | null | undefined;
  };
};

const byTitle = (left: SortableRecord, right: SortableRecord) =>
  normalizeRecipeText(left.recipe.title).localeCompare(normalizeRecipeText(right.recipe.title));

const applyDirection = <T>(records: T[], direction: CookbookSortDirection): T[] =>
  direction === "reverse" ? records.reverse() : records;

/** Total minutes for "Quickest"; recipes without any time sort after timed ones. */
const totalMinutesOf = (record: SortableRecord): number =>
  getRecipeTimes(record.recipe).total ?? Number.POSITIVE_INFINITY;

/**
 * Sorts Cookbook records. `getSavedAt` gives the date for "Recent" (savedAt for personal
 * recipes, createdAt for Family ones) and `getTimesCooked` the count for "Most cooked".
 * "Quickest" keeps untimed recipes at the end in both directions.
 */
export const sortCookbookRecords = <T extends SortableRecord>(
  records: readonly T[],
  sort: CookbookSort,
  direction: CookbookSortDirection,
  accessors: { getSavedAt: (record: T) => string; getTimesCooked?: (record: T) => number }
): T[] => {
  const recentFirst = (left: T, right: T) =>
    Date.parse(accessors.getSavedAt(right)) - Date.parse(accessors.getSavedAt(left));

  if (sort === "az") {
    return applyDirection([...records].sort(byTitle), direction);
  }

  if (sort === "mostCooked" && accessors.getTimesCooked) {
    const getTimesCooked = accessors.getTimesCooked;

    return applyDirection(
      [...records].sort(
        (left, right) => getTimesCooked(right) - getTimesCooked(left) || recentFirst(left, right)
      ),
      direction
    );
  }

  if (sort === "quickest") {
    const minutes = new Map(records.map((record) => [record, totalMinutesOf(record)]));
    const timed = records.filter((record) => Number.isFinite(minutes.get(record)));
    const untimed = records.filter((record) => !Number.isFinite(minutes.get(record)));
    const sortedTimed = [...timed].sort(
      (left, right) => (minutes.get(left) ?? 0) - (minutes.get(right) ?? 0) || byTitle(left, right)
    );

    return [...applyDirection(sortedTimed, direction), ...untimed.sort(byTitle)];
  }

  return applyDirection([...records].sort(recentFirst), direction);
};

export const getSortDirectionLabel = (sort: CookbookSort, direction: CookbookSortDirection) => {
  if (sort === "az") {
    return direction === "forward" ? "A to Z" : "Z to A";
  }

  if (sort === "mostCooked") {
    return direction === "forward" ? "Most cooked first" : "Least cooked first";
  }

  if (sort === "quickest") {
    return direction === "forward" ? "Quickest first" : "Longest first";
  }

  return direction === "forward" ? "Newest first" : "Oldest first";
};
