/**
 * Shared number-phrase vocabulary for recipe text.
 *
 * Ingredient amounts and cook-mode timers read the same kinds of numbers
 * ("1 1/2", "½", "0.25", "an"), so the fraction table, the source pattern, and
 * the parser live here. Keeping one copy stops the two call sites from drifting
 * apart — they previously disagreed about which vulgar fractions exist.
 */

export const VULGAR_FRACTION_VALUES: Readonly<Record<string, number>> = {
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

/** Character class body listing every vulgar fraction the parser understands. */
export const VULGAR_FRACTION_CHARACTERS = Object.keys(VULGAR_FRACTION_VALUES).join("");

const vulgarFractionClass = `[${VULGAR_FRACTION_CHARACTERS}]`;

/**
 * Source text (no capture groups) matching a bare number phrase: a decimal, a
 * mixed number, an ASCII fraction, or a vulgar fraction.
 */
export const NUMBER_PHRASE_PATTERN = String.raw`(?:\d+(?:\.\d+)?(?:\s+(?:\d+\/\d+|${vulgarFractionClass}))?|\d+\/\d+|${vulgarFractionClass})`;

/**
 * Parses one number phrase into a number, or null when the text is not a number.
 *
 * Understands decimals, ASCII fractions, mixed numbers, vulgar fractions, and
 * the articles "a"/"an" (as in "a minute"), which callers opt into by matching
 * them in their own pattern.
 */
export const parseNumberPhrase = (value: string): number | null => {
  const normalized = value.trim().toLowerCase();

  if (normalized === "a" || normalized === "an") {
    return 1;
  }

  const directVulgar = VULGAR_FRACTION_VALUES[normalized];

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
