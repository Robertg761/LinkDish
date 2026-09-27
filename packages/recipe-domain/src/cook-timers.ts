import {
  NUMBER_PHRASE_PATTERN,
  normalizeFractionSlashes,
  parseNumberPhrase,
  WORD_NUMBER_PATTERN
} from "./number-phrases.js";

export type ParsedStepDuration = {
  minSeconds: number;
  maxSeconds: number;
  label: string;
};

/**
 * Longest timer the UI will offer. Recipe text sometimes carries typos such as
 * "999999999 hours"; anything past a day is clamped so the value stays inside
 * the int32 millisecond range that `setTimeout` accepts (values above it wrap
 * and fire immediately).
 */
const MAX_DURATION_SECONDS = 24 * 60 * 60;

const numberPattern = `(?:${NUMBER_PHRASE_PATTERN}|${WORD_NUMBER_PATTERN}|a|an)`;

/**
 * One explicit duration. Units may be glued to the number ("10mins"); the one-letter forms
 * ("1h", "30m") only count when glued, so "5 m" is never read as minutes. "5-minute oats" never
 * matches because a hyphen is neither a range nor a unit separator here.
 */
const durationPattern = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:(?<qualifier>about|approximately|approx\.?|around|roughly|another|an additional|at least|up to)\s+)?` +
    String.raw`(?:(?<halfHour>half\s+an?\s+hour)|(?<first>${numberPattern})` +
    String.raw`(?:\s*(?:-|–|—|\bto\b)\s*(?<second>${numberPattern}))?` +
    String.raw`(?<gap>\s*)(?:(?<unit>seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b|(?<short>[hm])\b))` +
    String.raw`(?:\s+(?<per>per\s+(?:side|batch|round)))?`,
  "gi"
);

/** Glued one-letter units ("1h", "30m") need a digit before them, so "am" is never a minute. */
const PLAIN_NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;
/** Spelled-out numbers and articles need a space before the unit ("a min", never "amin"). */
const LETTER_START_PATTERN = /^[a-z]/i;

/** "Cook 30 seconds to 1 minute": the second half of such a range is not its own timer. */
const RANGE_TAIL_BEFORE_PATTERN = /\bto\s+$/i;
/** What may sit between the parts of a compound duration: "1 hour 30 minutes", "1 hr, 5 min". */
const COMPOUND_JOINER_PATTERN = /^\s*(?:,\s*)?(?:and\s+)?$/i;

const HOUR_SECONDS = 60 * 60;

const unitToSeconds = (unit: string): number => {
  const normalized = unit.toLowerCase();

  if (normalized.startsWith("h")) {
    return HOUR_SECONDS;
  }

  if (normalized.startsWith("s")) {
    return 1;
  }

  return 60;
};

const clampSeconds = (seconds: number): number =>
  Math.min(MAX_DURATION_SECONDS, Math.max(0, Math.round(seconds)));

type RawDuration = {
  start: number;
  end: number;
  minSeconds: number;
  maxSeconds: number;
  unitSeconds: number;
  isRange: boolean;
  hasQualifier: boolean;
  hasPer: boolean;
};

const readDuration = (match: RegExpMatchArray): RawDuration | null => {
  const groups = match.groups ?? {};
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const base = {
    start,
    end,
    hasQualifier: groups.qualifier != null,
    hasPer: groups.per != null
  };

  if (groups.halfHour) {
    return {
      ...base,
      minSeconds: HOUR_SECONDS / 2,
      maxSeconds: HOUR_SECONDS / 2,
      unitSeconds: HOUR_SECONDS,
      isRange: false
    };
  }

  const unitText = groups.unit ?? groups.short;

  if (!groups.first || !unitText) {
    return null;
  }

  const glued = (groups.gap ?? "").length === 0;

  if (
    (groups.short && (!glued || groups.second || !PLAIN_NUMBER_PATTERN.test(groups.first))) ||
    (glued && LETTER_START_PATTERN.test(groups.first))
  ) {
    return null;
  }

  const first = parseNumberPhrase(groups.first);
  const second = groups.second ? parseNumberPhrase(groups.second) : null;

  if (first == null || (groups.second && second == null)) {
    return null;
  }

  const unitSeconds = unitToSeconds(unitText);

  return {
    ...base,
    minSeconds: Math.min(first, second ?? first) * unitSeconds,
    maxSeconds: Math.max(first, second ?? first) * unitSeconds,
    unitSeconds,
    isRange: second != null
  };
};

/**
 * Joins "1 hour 30 minutes" (or "1 hr, 5 min", "1h 30m") into one duration: a larger unit
 * immediately followed by a smaller one, neither being a range.
 */
const canMergeCompound = (text: string, left: RawDuration, right: RawDuration): boolean =>
  !left.isRange &&
  !right.isRange &&
  !left.hasPer &&
  !right.hasQualifier &&
  left.unitSeconds > right.unitSeconds &&
  COMPOUND_JOINER_PATTERN.test(text.slice(left.end, right.start));

/**
 * Extracts cook-mode timer durations from a single recipe step.
 *
 * The parser intentionally recognizes explicit time units only. Temperatures,
 * counts, dates, clock references, and doneness cues such as "until golden"
 * are left unmatched so the UI never invents a timer. Compound durations
 * ("1 hour 30 minutes") become one timer. Durations are clamped to 24 hours,
 * and zero-length durations are dropped rather than surfaced as timers that
 * would fire instantly.
 */
export const parseStepDurations = (stepText: string): ParsedStepDuration[] => {
  const text = normalizeFractionSlashes(stepText);
  const raw: RawDuration[] = [];

  for (const match of text.matchAll(durationPattern)) {
    const matchIndex = match.index ?? 0;

    if (RANGE_TAIL_BEFORE_PATTERN.test(text.slice(Math.max(0, matchIndex - 4), matchIndex))) {
      continue;
    }

    const duration = readDuration(match);

    if (duration) {
      raw.push(duration);
    }
  }

  const merged: RawDuration[] = [];

  for (const duration of raw) {
    const previous = merged[merged.length - 1];

    if (previous && canMergeCompound(text, previous, duration)) {
      merged[merged.length - 1] = {
        ...previous,
        end: duration.end,
        minSeconds: previous.minSeconds + duration.minSeconds,
        maxSeconds: previous.maxSeconds + duration.maxSeconds,
        unitSeconds: duration.unitSeconds,
        hasPer: duration.hasPer
      };
      continue;
    }

    merged.push(duration);
  }

  const durations: ParsedStepDuration[] = [];

  for (const duration of merged) {
    const minSeconds = clampSeconds(duration.minSeconds);
    const maxSeconds = clampSeconds(duration.maxSeconds);

    if (maxSeconds <= 0) {
      continue;
    }

    durations.push({
      minSeconds,
      maxSeconds,
      label: text.slice(duration.start, duration.end).trim()
    });
  }

  return durations;
};
