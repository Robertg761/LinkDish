/**
 * Calendar-day keys ("YYYY-MM-DD") for the meal plan. Keys are local calendar days; arithmetic
 * runs in UTC so daylight-saving shifts never skip or repeat a day.
 */

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

const pad = (value: number): string => String(value).padStart(2, "0");

const parse = (key: string): { day: number; month: number; year: number } | null => {
  const match = DATE_KEY_PATTERN.exec(key);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { day, month, year };
};

/** True for a real calendar date written as "YYYY-MM-DD". */
export const isDateKey = (value: unknown): value is string =>
  typeof value === "string" && parse(value) !== null;

/** The local calendar day of `date` as "YYYY-MM-DD". */
export const toDateKey = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const addDaysToDateKey = (key: string, days: number): string => {
  const parts = parse(key);

  if (!parts) {
    throw new RangeError(`Not a date key: ${key}`);
  }

  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Math.trunc(days)));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

/** `days` consecutive keys starting at `start`. */
export const getDateKeyRange = (start: string, days: number): string[] =>
  Array.from({ length: Math.max(0, Math.trunc(days)) }, (_, index) =>
    addDaysToDateKey(start, index)
  );

/** 0 = Sunday … 6 = Saturday, for a date key. */
export const getDayOfWeek = (key: string): number => {
  const parts = parse(key);

  if (!parts) {
    throw new RangeError(`Not a date key: ${key}`);
  }

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

/** The first day of the week containing `key` (weeks start on Monday by default). */
export const getWeekStartDateKey = (key: string, weekStartsOn: 0 | 1 = 1): string => {
  const offset = (getDayOfWeek(key) - weekStartsOn + 7) % 7;
  return addDaysToDateKey(key, -offset);
};
