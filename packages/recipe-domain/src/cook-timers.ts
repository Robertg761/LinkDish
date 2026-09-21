import { NUMBER_PHRASE_PATTERN, parseNumberPhrase } from "./number-phrases.js";

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

const numberPattern = `(?:${NUMBER_PHRASE_PATTERN}|a|an)`;
const durationPattern = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:(about|approximately|approx\.?|around|roughly|another|an additional|at least|up to)\s+)?` +
    String.raw`(${numberPattern})` +
    String.raw`(?:\s*(?:-|–|—|\bto\b)\s*(${numberPattern}))?` +
    String.raw`\s+(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b` +
    String.raw`(?:\s+(per\s+(?:side|batch|round)))?`,
  "gi"
);

const unitToSeconds = (unit: string): number => {
  const normalized = unit.toLowerCase();

  if (normalized.startsWith("hour") || normalized === "hr" || normalized === "hrs") {
    return 60 * 60;
  }

  if (normalized.startsWith("sec")) {
    return 1;
  }

  return 60;
};

const clampSeconds = (seconds: number): number =>
  Math.min(MAX_DURATION_SECONDS, Math.max(0, Math.round(seconds)));

/**
 * Extracts cook-mode timer durations from a single recipe step.
 *
 * The parser intentionally recognizes explicit time units only. Temperatures,
 * counts, dates, clock references, and doneness cues such as "until golden"
 * are left unmatched so the UI never invents a timer. Durations are clamped to
 * 24 hours, and zero-length durations are dropped rather than surfaced as
 * timers that would fire instantly.
 */
export const parseStepDurations = (stepText: string): ParsedStepDuration[] => {
  const durations: ParsedStepDuration[] = [];

  for (const match of stepText.matchAll(durationPattern)) {
    const matchIndex = match.index ?? 0;
    const beforeMatch = stepText.slice(Math.max(0, matchIndex - 4), matchIndex);

    if (/\bto\s+$/i.test(beforeMatch)) {
      continue;
    }

    const firstText = match[2];
    const unitText = match[4];

    if (!firstText || !unitText) {
      continue;
    }

    const first = parseNumberPhrase(firstText);
    const second = match[3] ? parseNumberPhrase(match[3]) : null;

    if (first == null || (match[3] && second == null)) {
      continue;
    }

    const multiplier = unitToSeconds(unitText);
    const minValue = Math.min(first, second ?? first);
    const maxValue = Math.max(first, second ?? first);
    const minSeconds = clampSeconds(minValue * multiplier);
    const maxSeconds = clampSeconds(maxValue * multiplier);

    if (maxSeconds <= 0) {
      continue;
    }

    durations.push({
      minSeconds,
      maxSeconds,
      label: match[0].trim()
    });
  }

  return durations;
};
