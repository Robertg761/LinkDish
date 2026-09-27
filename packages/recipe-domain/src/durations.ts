/**
 * Recipe times: reading ISO 8601 and free-text durations into minutes, and printing minutes the
 * way a recipe card does ("45 min", "1 hr 30 min").
 */
import { parseStepDurations } from "./cook-timers.js";

export type FormatDurationOptions = {
  /** "short" (default): "1 hr 30 min". "long": "1 hour 30 minutes". */
  style?: "short" | "long" | undefined;
};

export type RecipeTimes = {
  /** Minutes, or null when unknown. */
  prep: number | null;
  cook: number | null;
  /** The recipe's total time when it gives one, otherwise prep + cook. */
  total: number | null;
  /** Formatted times ("15 min"), null when unknown. Zero cook time shows as null. */
  labels: { prep: string | null; cook: string | null; total: string | null };
  /** One-line summary: "Prep 15 min · Cook 38 min · Total 53 min" ("" when nothing is known). */
  display: string;
};

type RecipeTimeFields = {
  prepTimeMinutes?: number | null | undefined;
  cookTimeMinutes?: number | null | undefined;
  totalTimeMinutes?: number | null | undefined;
};

/**
 * ISO 8601 durations as schema.org uses them: "PT1H30M", "P0DT0H45M", "PT0.5H", "P1D",
 * "PT90S". Weeks are allowed ("P1W"); years and months are not durations a recipe needs.
 */
const ISO_DURATION_PATTERN =
  /^P(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i;
/** "P" followed by a digit or "T" ("PT45M", "P1D", or a bare "P"); "Prep 10 min" is text. */
const ISO_START_PATTERN = /^P(?:[\dT]|$)/i;
const CLOCK_DURATION_PATTERN = /^(\d{1,3}):([0-5]\d)$/u;
const PLAIN_MINUTES_PATTERN = /^\d+(?:\.\d+)?$/u;
const MAX_DURATION_MINUTES = 7 * 24 * 60;

const readIsoNumber = (value: string | undefined): number =>
  value == null ? 0 : Number(value.replace(",", "."));

const parseIsoDuration = (value: string): number | null => {
  const match = ISO_DURATION_PATTERN.exec(value);

  if (!match || value.toUpperCase() === "P" || value.toUpperCase().endsWith("T")) {
    return null;
  }

  const [, weeks, days, hours, minutes, seconds] = match;
  const total =
    readIsoNumber(weeks) * 7 * 24 * 60 +
    readIsoNumber(days) * 24 * 60 +
    readIsoNumber(hours) * 60 +
    readIsoNumber(minutes) +
    readIsoNumber(seconds) / 60;

  return Number.isFinite(total) ? total : null;
};

/**
 * Minutes in a duration written as ISO 8601 ("PT1H30M", "P0DT0H45M") or as text ("1 hour 30
 * minutes", "1½ hours", "45 min", "1:30", "90"). Text ranges ("10-15 minutes") count their upper
 * end so a "ready in" estimate is never optimistic; several durations in one string add up
 * ("Prep 10 min, cook 20 min" → 30). Returns null for anything without a duration
 * ("overnight"), rounded to whole minutes and capped at a week.
 */
export const parseDuration = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? Math.min(MAX_DURATION_MINUTES, Math.round(value))
      : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  let minutes: number | null;

  if (ISO_START_PATTERN.test(trimmed)) {
    minutes = parseIsoDuration(trimmed);
  } else if (PLAIN_MINUTES_PATTERN.test(trimmed)) {
    minutes = Number(trimmed);
  } else {
    const clock = CLOCK_DURATION_PATTERN.exec(trimmed);

    if (clock) {
      minutes = Number(clock[1]) * 60 + Number(clock[2]);
    } else {
      const durations = parseStepDurations(trimmed);
      minutes =
        durations.length === 0
          ? null
          : durations.reduce((total, duration) => total + duration.maxSeconds, 0) / 60;
    }
  }

  return minutes == null || !Number.isFinite(minutes) || minutes < 0
    ? null
    : Math.min(MAX_DURATION_MINUTES, Math.round(minutes));
};

const plural = (count: number, singular: string, pluralForm: string): string =>
  count === 1 ? singular : pluralForm;

/**
 * Prints minutes for a recipe card: "45 min", "1 hr 30 min", "3 hr", "1 day 2 hr". The long
 * style spells units out ("1 hour 30 minutes"). Invalid or negative input prints "".
 */
export const formatDuration = (
  minutes: number | null | undefined,
  options: FormatDurationOptions = {}
): string => {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) {
    return "";
  }

  const long = options.style === "long";
  const rounded = Math.round(minutes);
  const days = Math.floor(rounded / (24 * 60));
  const hours = Math.floor((rounded % (24 * 60)) / 60);
  const mins = rounded % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days} ${plural(days, "day", "days")}`);
  }

  if (hours > 0) {
    parts.push(long ? `${hours} ${plural(hours, "hour", "hours")}` : `${hours} hr`);
  }

  if (mins > 0 || parts.length === 0) {
    parts.push(long ? `${mins} ${plural(mins, "minute", "minutes")}` : `${mins} min`);
  }

  return parts.join(" ");
};

const validMinutes = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/**
 * Prep, cook and total minutes for a recipe, with labels and a one-line summary. The total is
 * the recipe's own `totalTimeMinutes` when present (it can include resting or rising time),
 * otherwise prep + cook.
 */
export const getRecipeTimes = (recipe: RecipeTimeFields): RecipeTimes => {
  const prep = validMinutes(recipe.prepTimeMinutes);
  const cook = validMinutes(recipe.cookTimeMinutes);
  const givenTotal = validMinutes(recipe.totalTimeMinutes);
  const total = givenTotal ?? (prep == null && cook == null ? null : (prep ?? 0) + (cook ?? 0));
  const label = (value: number | null): string | null =>
    value == null || value === 0 ? null : formatDuration(value);
  const labels = { prep: label(prep), cook: label(cook), total: label(total) };
  const summary = [
    labels.prep ? `Prep ${labels.prep}` : null,
    labels.cook ? `Cook ${labels.cook}` : null,
    labels.total ? `Total ${labels.total}` : null
  ]
    .filter((part): part is string => part != null)
    .join(" · ");

  return { prep, cook, total, labels, display: summary };
};
