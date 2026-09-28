/**
 * Servings and yield. Recipe sites write `servings` as free text ("4-6 servings", "Makes 12
 * cookies", "16, 1 loaf", "36, 36 cookies", "4 quarts, 10-14 serving(s)"); this module reads a
 * count out of it for scaling by servings and renders a clean label for the recipe header.
 */
import { NUMBER_PHRASE_PATTERN, parseNumberPhrase, WORD_NUMBER_PATTERN } from "./number-phrases.js";
import { formatQuantity } from "./quantity-format.js";

export type ParsedServings = {
  /** Smallest count ("4" in "4-6 servings"). */
  min: number;
  /** Largest count; equal to `min` for a single number. */
  max: number;
  /** "servings" when the count is people served, "items" when it counts things made. */
  kind: "servings" | "items";
  /** What is counted when it is not servings: "cookies", "bars", "small pancakes". */
  noun?: string | undefined;
  /** An extra yield the source listed next to the servings ("1 loaf", "4 quarts"). */
  yield?: string | undefined;
  /** Clean label: "Serves 16 · 1 loaf", "36 cookies", "Serves 4–6". */
  display: string;
};

export type FormatServingsOptions = {
  /** Multiplies the counts (for a scaled recipe); the side yield is dropped when scaled. */
  scale?: number | undefined;
};

const NUMBER = `(?:${NUMBER_PHRASE_PATTERN}|${WORD_NUMBER_PATTERN}|a\\s+dozen)`;
const SEGMENT_PATTERN = new RegExp(
  String.raw`^(?:about|approx\.?|approximately|around|roughly|up to|at least|~)?\s*(${NUMBER})` +
    String.raw`(?:\s*(?:-|–|—|to|or)\s*(${NUMBER}))?\s*(.*)$`,
  "i"
);
const PREFIX_PATTERN =
  /^(?:yields?|makes|serves|servings?|portions?|serving size|recipe yield|feeds)\s*[:\-–]?\s*/i;
const SERVES_PREFIX_PATTERN = /^(?:serves|servings?|portions?|feeds)\b/i;
const MAKES_PREFIX_PATTERN = /^(?:yields?|makes|recipe yield)\b/i;
const SEGMENT_SEPARATOR_PATTERN = /\s*[,;]\s*|\s+\/\s+/u;
const SERVING_NOUN_PATTERN =
  /^(?:servings?|serving\(s\)|portions?|people|persons?|adults?|guests?|serves)\b/i;
const DOZEN_PATTERN = /^dozen\b\s*/i;
const PARENTHETICAL_PATTERN = /\s*\([^)]*\)\s*/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const TRAILING_PUNCTUATION_PATTERN = /[.:;,\s]+$/u;
/** Side yields longer than this make the header label too long, so the label drops them. */
const MAX_YIELD_LABEL_LENGTH = 24;

type Segment = { min: number; max: number; noun: string; text: string };

const readCount = (text: string): number | null => {
  const lower = text.trim().toLowerCase();

  if (lower === "a dozen") {
    return 12;
  }

  return parseNumberPhrase(lower);
};

const parseSegment = (text: string): Segment | null => {
  const match = SEGMENT_PATTERN.exec(text.trim());

  if (!match) {
    return null;
  }

  const first = readCount(match[1] ?? "");
  const second = match[2] ? readCount(match[2]) : null;

  if (first == null || first <= 0 || (match[2] && (second == null || second <= 0))) {
    return null;
  }

  let min = Math.min(first, second ?? first);
  let max = Math.max(first, second ?? first);
  let noun = (match[3] ?? "")
    .replace(PARENTHETICAL_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .replace(TRAILING_PUNCTUATION_PATTERN, "")
    .trim();

  if (DOZEN_PATTERN.test(noun)) {
    min *= 12;
    max *= 12;
    noun = noun.replace(DOZEN_PATTERN, "");
  }

  return { min, max, noun, text: text.trim() };
};

const isServingSegment = (segment: Segment): boolean =>
  segment.noun.length === 0 || SERVING_NOUN_PATTERN.test(segment.noun);

const formatCount = (min: number, max: number): string =>
  formatQuantity(min === max ? min : { min, max });

const buildDisplay = (servings: Omit<ParsedServings, "display">): string => {
  const count = formatCount(servings.min, servings.max);

  if (servings.kind === "items") {
    return servings.noun ? `${count} ${servings.noun}` : `Makes ${count}`;
  }

  return servings.yield && servings.yield.length <= MAX_YIELD_LABEL_LENGTH
    ? `Serves ${count} · ${servings.yield}`
    : `Serves ${count}`;
};

/**
 * Reads a servings/yield string. Returns null when it carries no usable count ("Varies").
 *
 * - "4 servings", "Serves 4", "6 serving(s)", "Serves four" → Serves 4 / 6
 * - "4-6 servings", "Serves 4 to 6" → Serves 4–6
 * - "Makes 12 cookies", "9 bars", "2 dozen cookies" → items with a noun
 * - "16, 1 loaf" → Serves 16 · 1 loaf; "36, 36 cookies" → 36 cookies
 * - "4 quarts, 10-14 serving(s)" → Serves 10–14 · 4 quarts
 */
export const parseServings = (value: string | null | undefined): ParsedServings | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.replace(WHITESPACE_PATTERN, " ").trim();

  if (trimmed.length === 0) {
    return null;
  }

  const servesPrefix = SERVES_PREFIX_PATTERN.test(trimmed);
  const body = trimmed.replace(PREFIX_PATTERN, "");
  const segments = body
    .split(SEGMENT_SEPARATOR_PATTERN)
    .map(parseSegment)
    .filter((segment): segment is Segment => segment != null);

  if (segments.length === 0) {
    return null;
  }

  const servingSegment = segments.find(isServingSegment);
  const itemSegment = segments.find((segment) => !isServingSegment(segment));
  let parsed: Omit<ParsedServings, "display">;

  if (servingSegment && itemSegment && !servesPrefix && itemSegment.min === servingSegment.min) {
    // "36, 36 cookies": the item count restates the servings, and names them.
    parsed = { min: itemSegment.min, max: itemSegment.max, kind: "items", noun: itemSegment.noun };
  } else if (
    servingSegment &&
    !itemSegment &&
    servingSegment.noun.length === 0 &&
    MAKES_PREFIX_PATTERN.test(trimmed)
  ) {
    // "Makes 2 dozen": a count of things made, with nothing named.
    parsed = { min: servingSegment.min, max: servingSegment.max, kind: "items" };
  } else if (servingSegment || servesPrefix) {
    const counted = servingSegment ?? segments[0];

    if (!counted) {
      return null;
    }

    const sideYield = itemSegment && itemSegment !== counted ? itemSegment.text : undefined;
    parsed = {
      min: counted.min,
      max: counted.max,
      kind: "servings",
      ...(sideYield ? { yield: sideYield } : {})
    };
  } else if (itemSegment) {
    parsed = { min: itemSegment.min, max: itemSegment.max, kind: "items", noun: itemSegment.noun };
  } else {
    return null;
  }

  return { ...parsed, display: buildDisplay(parsed) };
};

/**
 * Header label for a servings string or parsed value, optionally scaled: "Serves 8",
 * "24 cookies", "Serves 4–6". Unparseable strings come back trimmed as written.
 */
export const formatServings = (
  servings: ParsedServings | string | null | undefined,
  options: FormatServingsOptions = {}
): string => {
  const parsed =
    typeof servings === "string" || servings == null ? parseServings(servings) : servings;

  if (!parsed) {
    return typeof servings === "string" ? servings.trim() : "";
  }

  const scale = options.scale ?? 1;

  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
    return parsed.display;
  }

  // The side yield ("1 loaf") describes the unscaled recipe, so a scaled label leaves it out.
  return buildDisplay({
    min: parsed.min * scale,
    max: parsed.max * scale,
    kind: parsed.kind,
    ...(parsed.noun ? { noun: parsed.noun } : {})
  });
};

/**
 * Scale factor that turns a recipe's servings into `targetServings`, measured from the low end
 * of a range ("Serves 4–6" → 8 is ×2). Returns 1 when either side is unusable.
 */
export const scaleFactorForServings = (
  servings: ParsedServings | string | null | undefined,
  targetServings: number
): number => {
  const parsed =
    typeof servings === "string" || servings == null ? parseServings(servings) : servings;

  if (!parsed || !Number.isFinite(targetServings) || targetServings <= 0 || parsed.min <= 0) {
    return 1;
  }

  return targetServings / parsed.min;
};
