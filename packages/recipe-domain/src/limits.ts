/**
 * Size limits and small constants shared by the contracts and the pure helpers. Kept free of
 * zod so bundles that only need aggregation or planning helpers do not pull the schema library.
 */
export const MAX_RECIPE_TITLE_LENGTH = 300;
export const MAX_SHOPPING_ITEM_TEXT_LENGTH = 200;

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const MAX_MEAL_PLAN_NOTE_LENGTH = 2_000;
export const MAX_MEAL_PLAN_SERVINGS = 1_000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** True for a real calendar date written as YYYY-MM-DD. */
export const isValidIsoDate = (value: string): boolean => {
  const match = ISO_DATE_PATTERN.exec(value);

  if (!match) {
    return false;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};
