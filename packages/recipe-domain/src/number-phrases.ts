/**
 * Shared number-phrase vocabulary for recipe text.
 *
 * Ingredient amounts and cook-mode timers read the same kinds of numbers
 * ("1 1/2", "1-1/2", "1½", "½", "0.25", ".5", "an"), so the fraction table, the source pattern,
 * and the parser live here. Keeping one copy stops the two call sites from drifting
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

/** Spelled-out numbers read by the ingredient and timer parsers ("one onion", "five minutes"). */
export const WORD_NUMBER_VALUES: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  "forty-five": 45,
  forty: 40,
  sixty: 60,
  ninety: 90
};

/** Source text (no capture groups) for a spelled-out number, bounded so "onest" never matches. */
export const WORD_NUMBER_PATTERN = String.raw`(?:${Object.keys(WORD_NUMBER_VALUES)
  .sort((left, right) => right.length - left.length)
  .join("|")})(?![A-Za-z])`;

const vulgarFractionClass = `[${VULGAR_FRACTION_CHARACTERS}]`;
const asciiFraction = String.raw`\d+\/\d+`;

/**
 * Source text (no capture groups) matching a bare number phrase, most specific first:
 * - a hyphenated mixed number ("1-1/2", "2-½"), which US recipes use for one and a half, never
 *   for a range from one down to a half;
 * - a decimal or whole number with an optional fraction, spaced or glued ("1 1/2", "1 ½", "1½");
 * - an ASCII fraction ("3/4"), a leading-dot decimal (".5") or a vulgar fraction ("½").
 *
 * The fraction after a whole number is a glued vulgar fraction, or whitespace and then either
 * kind: one `\s+` instead of the overlapping `\s*½|\s+1/2`, so the spaces are scanned once.
 *
 * Callers normalize the Unicode fraction slash (U+2044 "1⁄2") to "/" first; see
 * `normalizeFractionSlashes`.
 */
export const NUMBER_PHRASE_PATTERN = String.raw`(?:\d+-(?:${asciiFraction}|${vulgarFractionClass})|\d+(?:\.\d+)?(?:${vulgarFractionClass}|\s+(?:${vulgarFractionClass}|${asciiFraction}))?|${asciiFraction}|\.\d+|${vulgarFractionClass})`;

const FRACTION_SLASH_PATTERN = /[⁄∕]/u;
const WHITESPACE_PATTERN = /\s+/u;
const HYPHENATED_MIXED_PATTERN = /^(\d+)-(.+)$/u;
const GLUED_VULGAR_PATTERN = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${vulgarFractionClass})$`, "u");

/**
 * Rewrites the Unicode fraction slash (U+2044, and the division slash U+2215) as an ASCII "/",
 * dropping the spaces some sites put around it ("1 ⁄ 2" → "1/2").
 *
 * Splits on the slash and trims the pieces instead of a global replace of `\s*[⁄∕]\s*`, which
 * rescanned a run of spaces from each of its positions (quadratic on long runs); the result is
 * the same, since `trim` removes exactly the characters `\s` matches.
 */
export const normalizeFractionSlashes = (text: string): string => {
  if (!text.includes("⁄") && !text.includes("∕")) {
    return text;
  }

  const pieces = text.split(FRACTION_SLASH_PATTERN);
  const last = pieces.length - 1;

  return pieces
    .map((piece, index) => {
      const trimmedStart = index > 0 ? piece.trimStart() : piece;
      return index < last ? trimmedStart.trimEnd() : trimmedStart;
    })
    .join("/");
};

const parseProperFraction = (value: string): number | null => {
  const parsed = parseNumberPhrase(value);
  return parsed != null && parsed > 0 && parsed < 1 ? parsed : null;
};

/**
 * Parses one number phrase into a number, or null when the text is not a number.
 *
 * Understands decimals, ASCII and Unicode-slash fractions, mixed numbers (spaced, glued or
 * hyphenated), vulgar fractions, spelled-out numbers, and the articles "a"/"an" (as in
 * "a minute"), which callers opt into by matching them in their own pattern.
 */
export const parseNumberPhrase = (value: string): number | null => {
  const normalized = normalizeFractionSlashes(value).trim().toLowerCase();

  if (normalized === "a" || normalized === "an") {
    return 1;
  }

  const word = WORD_NUMBER_VALUES[normalized];
  if (word != null) {
    return word;
  }

  const directVulgar = VULGAR_FRACTION_VALUES[normalized];

  if (directVulgar != null) {
    return directVulgar;
  }

  const hyphenated = HYPHENATED_MIXED_PATTERN.exec(normalized);
  if (hyphenated) {
    const fraction = parseProperFraction(hyphenated[2] ?? "");
    return fraction == null ? null : Number(hyphenated[1]) + fraction;
  }

  const glued = GLUED_VULGAR_PATTERN.exec(normalized);
  if (glued) {
    const whole = Number(glued[1]);
    const fraction = VULGAR_FRACTION_VALUES[glued[2] ?? ""];
    return Number.isFinite(whole) && fraction != null ? whole + fraction : null;
  }

  const parts = normalized.split(WHITESPACE_PATTERN);
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
