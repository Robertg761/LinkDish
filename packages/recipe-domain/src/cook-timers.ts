export type ParsedStepDuration = {
  minSeconds: number;
  maxSeconds: number;
  label: string;
};

const vulgarFractionValues: Record<string, number> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 1 / 10,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8
};

const numberPattern = String.raw`(?:\d+(?:\.\d+)?(?:\s+(?:\d+\/\d+|[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]))?|\d+\/\d+|[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|a|an)`;
const durationPattern = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:(about|approximately|approx\.?|around|roughly|another|an additional|at least|up to)\s+)?` +
    String.raw`(${numberPattern})` +
    String.raw`(?:\s*(?:-|–|—|\bto\b)\s*(${numberPattern}))?` +
    String.raw`\s+(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hr)\b` +
    String.raw`(?:\s+(per\s+(?:side|batch|round)))?`,
  "gi"
);

const parseNumberPhrase = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();

  if (normalized === "a" || normalized === "an") {
    return 1;
  }

  const directVulgar = vulgarFractionValues[normalized];
  if (directVulgar != null) {
    return directVulgar;
  }

  const parts = normalized.split(/\s+/);
  if (parts.length === 2) {
    const whole = Number(parts[0]);
    const fraction = parseNumberPhrase(parts[1] ?? "");

    if (Number.isFinite(whole) && fraction != null && fraction > 0 && fraction < 1) {
      return whole + fraction;
    }
  }

  if (normalized.includes("/")) {
    const [numeratorText, denominatorText] = normalized.split("/");
    const numerator = Number(numeratorText);
    const denominator = Number(denominatorText);

    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
};

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

/**
 * Extracts cook-mode timer durations from a single recipe step.
 *
 * The parser intentionally recognizes explicit time units only. Temperatures,
 * counts, dates, clock references, and doneness cues such as "until golden"
 * are left unmatched so the UI never invents a timer.
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

    durations.push({
      minSeconds: Math.round(minValue * multiplier),
      maxSeconds: Math.round(maxValue * multiplier),
      label: match[0].trim()
    });
  }

  return durations;
};
