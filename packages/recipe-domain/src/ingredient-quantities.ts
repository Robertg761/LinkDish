import { NUMBER_PHRASE_PATTERN, parseNumberPhrase } from "./number-phrases.js";

export type ParsedQuantityValue = number | { min: number; max: number } | null;

export type ParsedIngredientQuantity = {
  qty: ParsedQuantityValue;
  unit: string | null;
  altQty: ParsedQuantityValue;
  altUnit: string | null;
  item: string;
  confident: boolean;
};

type UnitDefinition = {
  aliases: readonly string[];
  /**
   * Aliases that only match with their exact casing. Used for single letters
   * where case is the only thing separating two units ("T" tablespoon vs
   * "t" teaspoon).
   */
  caseSensitiveAliases?: readonly string[];
  canonical: string;
  singular: string;
  plural: string;
  compact?: string;
  fractional: boolean;
  whole: boolean;
};

/**
 * Fractions the renderer is allowed to print, smallest first. Anything not in
 * this list is rendered as a decimal rather than snapped to a nearby fraction.
 */
const fractionCandidates: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1 / 8, label: "⅛" },
  { value: 1 / 6, label: "⅙" },
  { value: 1 / 4, label: "¼" },
  { value: 1 / 3, label: "⅓" },
  { value: 3 / 8, label: "⅜" },
  { value: 1 / 2, label: "½" },
  { value: 5 / 8, label: "⅝" },
  { value: 2 / 3, label: "⅔" },
  { value: 3 / 4, label: "¾" },
  { value: 7 / 8, label: "⅞" }
];

/**
 * How far a value may sit from a printable fraction, relative to the value
 * itself, before the renderer gives up and prints a decimal. 1/16 keeps
 * ordinary rounding (1.05 cups -> "1") while refusing to call 1/16 tsp "⅛".
 */
const fractionRelativeTolerance = 1 / 16;

/** Scale factors outside this range produce unusable text, so they are clamped. */
const minScaleFactor = 0.05;
const maxScaleFactor = 50;

const unitDefinitions: readonly UnitDefinition[] = [
  {
    aliases: ["tablespoons", "tablespoon", "tbsp.", "tbsp", "tbs.", "tbs"],
    caseSensitiveAliases: ["T"],
    canonical: "Tbsp",
    singular: "tablespoon",
    plural: "tablespoons",
    compact: "Tbsp",
    fractional: true,
    whole: false
  },
  {
    aliases: ["teaspoons", "teaspoon", "tsp.", "tsp"],
    caseSensitiveAliases: ["t"],
    canonical: "tsp",
    singular: "teaspoon",
    plural: "teaspoons",
    compact: "tsp",
    fractional: true,
    whole: false
  },
  {
    aliases: ["cups", "cup", "c.", "c"],
    canonical: "cup",
    singular: "cup",
    plural: "cups",
    fractional: true,
    whole: false
  },
  {
    aliases: ["pounds", "pound", "lbs.", "lbs", "lb."],
    canonical: "lb",
    singular: "pound",
    plural: "pounds",
    compact: "lb",
    fractional: false,
    whole: false
  },
  {
    aliases: [
      "fluid ounces",
      "fluid ounce",
      "fl. oz.",
      "fl. oz",
      "fl oz.",
      "fl oz",
      "floz"
    ],
    canonical: "fl oz",
    singular: "fluid ounce",
    plural: "fluid ounces",
    compact: "fl oz",
    fractional: true,
    whole: false
  },
  {
    aliases: ["ounces", "ounce", "oz."],
    canonical: "oz",
    singular: "ounce",
    plural: "ounces",
    compact: "oz",
    fractional: false,
    whole: false
  },
  {
    aliases: ["grams", "gram"],
    canonical: "g",
    singular: "gram",
    plural: "grams",
    compact: "g",
    fractional: false,
    whole: false
  },
  {
    aliases: ["kilograms", "kilogram"],
    canonical: "kg",
    singular: "kilogram",
    plural: "kilograms",
    compact: "kg",
    fractional: false,
    whole: false
  },
  {
    aliases: ["milliliters", "milliliter"],
    canonical: "ml",
    singular: "milliliter",
    plural: "milliliters",
    compact: "ml",
    fractional: false,
    whole: false
  },
  {
    aliases: ["liters", "liter"],
    canonical: "l",
    singular: "liter",
    plural: "liters",
    compact: "l",
    fractional: false,
    whole: false
  },
  {
    aliases: ["quarts", "quart", "qts.", "qts", "qt.", "qt"],
    canonical: "qt",
    singular: "quart",
    plural: "quarts",
    compact: "qt",
    fractional: true,
    whole: false
  },
  {
    aliases: ["pints", "pint", "pts.", "pts", "pt.", "pt"],
    canonical: "pt",
    singular: "pint",
    plural: "pints",
    compact: "pt",
    fractional: true,
    whole: false
  },
  {
    aliases: ["gallons", "gallon", "gal.", "gal"],
    canonical: "gal",
    singular: "gallon",
    plural: "gallons",
    compact: "gal",
    fractional: true,
    whole: false
  },
  {
    aliases: ["cans", "can"],
    canonical: "can",
    singular: "can",
    plural: "cans",
    fractional: false,
    whole: true
  },
  {
    aliases: ["cloves", "clove"],
    canonical: "clove",
    singular: "clove",
    plural: "cloves",
    fractional: false,
    whole: true
  },
  {
    aliases: ["handfuls", "handful"],
    canonical: "handful",
    singular: "handful",
    plural: "handfuls",
    fractional: false,
    whole: true
  },
  {
    aliases: ["sticks", "stick"],
    canonical: "stick",
    singular: "stick",
    plural: "sticks",
    fractional: true,
    whole: false
  },
  {
    aliases: ["pinches", "pinch"],
    canonical: "pinch",
    singular: "pinch",
    plural: "pinches",
    fractional: false,
    whole: true
  },
  {
    aliases: ["dashes", "dash"],
    canonical: "dash",
    singular: "dash",
    plural: "dashes",
    fractional: true,
    whole: false
  },
  {
    aliases: ["bunches", "bunch"],
    canonical: "bunch",
    singular: "bunch",
    plural: "bunches",
    fractional: true,
    whole: false
  },
  {
    aliases: ["slices", "slice"],
    canonical: "slice",
    singular: "slice",
    plural: "slices",
    fractional: false,
    whole: true
  },
  {
    aliases: ["packages", "package", "pkgs.", "pkgs", "pkg.", "pkg"],
    canonical: "package",
    singular: "package",
    plural: "packages",
    fractional: false,
    whole: true
  },
  {
    aliases: ["g"],
    canonical: "g",
    singular: "g",
    plural: "g",
    compact: "g",
    fractional: false,
    whole: false
  },
  {
    aliases: ["kg"],
    canonical: "kg",
    singular: "kg",
    plural: "kg",
    compact: "kg",
    fractional: false,
    whole: false
  },
  {
    aliases: ["ml"],
    canonical: "ml",
    singular: "ml",
    plural: "ml",
    compact: "ml",
    fractional: false,
    whole: false
  },
  {
    aliases: ["l"],
    canonical: "l",
    singular: "l",
    plural: "l",
    compact: "l",
    fractional: false,
    whole: false
  },
  {
    aliases: ["oz"],
    canonical: "oz",
    singular: "oz",
    plural: "oz",
    compact: "oz",
    fractional: false,
    whole: false
  },
  {
    aliases: ["lb"],
    canonical: "lb",
    singular: "lb",
    plural: "lb",
    compact: "lb",
    fractional: false,
    whole: false
  }
];

const unitAliasLookup = new Map(
  unitDefinitions.flatMap((definition) =>
    definition.aliases.map((alias) => [alias.toLowerCase(), definition] as const)
  )
);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Alias matchers, compiled once at module load. `parseUnit` runs on every
 * ingredient line on every scale change, so building ~60 regexes per call was
 * measurable. Order mirrors the definition order above: first match wins.
 */
const unitMatchers: ReadonlyArray<{ definition: UnitDefinition; pattern: RegExp }> =
  unitDefinitions.flatMap((definition) => [
    ...definition.aliases.map((alias) => ({
      definition,
      pattern: new RegExp(`^${escapeRegExp(alias)}(?=\\s|$|,|\\])`, "i")
    })),
    ...(definition.caseSensitiveAliases ?? []).map((alias) => ({
      definition,
      pattern: new RegExp(`^${escapeRegExp(alias)}(?=\\s|$|,|\\])`)
    }))
  ]);

const leadingQuantityPattern = new RegExp(
  String.raw`^\s*(${NUMBER_PHRASE_PATTERN})(?:\s*(?:-|–|—|\bto\b)\s*(${NUMBER_PHRASE_PATTERN}))?(?=\s|$)`,
  "i"
);

const unconfident = (text: string): ParsedIngredientQuantity => ({
  qty: null,
  unit: null,
  altQty: null,
  altUnit: null,
  item: text.trim(),
  confident: false
});

const parseQuantityValue = (text: string): { value: Exclude<ParsedQuantityValue, null>; rest: string } | null => {
  const match = leadingQuantityPattern.exec(text);

  if (!match) {
    return null;
  }

  const first = parseNumberPhrase(match[1] ?? "");
  const second = match[2] ? parseNumberPhrase(match[2]) : null;

  if (first == null || (match[2] && second == null)) {
    return null;
  }

  const value = second == null ? first : { min: Math.min(first, second), max: Math.max(first, second) };
  return {
    value,
    rest: text.slice(match[0].length).trim()
  };
};

const parseUnit = (text: string): { definition: UnitDefinition; rest: string } | null => {
  const trimmed = text.trimStart();

  for (const matcher of unitMatchers) {
    const match = matcher.pattern.exec(trimmed);

    if (match) {
      return {
        definition: matcher.definition,
        rest: trimmed.slice(match[0].length).replace(/^\s+of\b/i, "").trim()
      };
    }
  }

  return null;
};

const parseAltQuantity = (text: string): { qty: ParsedQuantityValue; unit: string | null; rest: string } => {
  const match = /^\[([^\]]+)\]\s*/.exec(text.trimStart());

  if (!match) {
    return { qty: null, unit: null, rest: text.trim() };
  }

  const parsedAlt = parseQuantityValue(match[1] ?? "");
  if (!parsedAlt) {
    return { qty: null, unit: null, rest: text.trim() };
  }

  const unit = parseUnit(parsedAlt.rest);
  if (!unit) {
    return { qty: null, unit: null, rest: text.trim() };
  }

  return {
    qty: parsedAlt.value,
    unit: unit.definition.canonical,
    rest: text.trimStart().slice(match[0].length).trim()
  };
};

const scaleValue = (value: Exclude<ParsedQuantityValue, null>, factor: number): Exclude<ParsedQuantityValue, null> =>
  typeof value === "number"
    ? value * factor
    : {
        min: value.min * factor,
        max: value.max * factor
      };

const formatDecimal = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const rounded = Math.round(value);

  if (Math.abs(value - rounded) < 0.001 && (rounded !== 0 || value === 0)) {
    return String(rounded);
  }

  if (Math.abs(value) >= 10) {
    return String(Math.round(value));
  }

  if (Math.abs(value) >= 1) {
    return String(Math.round(value * 10) / 10);
  }

  // Small amounts keep two decimals so a scaled-down pinch stays honest
  // ("0.06 tsp") instead of rounding away to "0" or "0.1".
  const twoPlaces = Number(value.toFixed(2));
  return twoPlaces === 0 ? String(Number(value.toPrecision(1))) : String(twoPlaces);
};

/**
 * Renders a value using the fraction nearest to it, or a decimal when no
 * printable fraction is close enough. Quantizing against an explicit candidate
 * set (rather than rounding to eighths) is what lets thirds and sixths survive.
 */
const tryVulgarFraction = (value: number): string | null => {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  const rounded = Math.round(value);

  if (Math.abs(value - rounded) < 0.001) {
    return String(rounded);
  }

  const whole = Math.floor(value);
  const fraction = value - whole;
  const tolerance = value * fractionRelativeTolerance;

  let bestDistance = fraction;
  let bestText = String(whole);

  const distanceToNextWhole = 1 - fraction;
  if (distanceToNextWhole < bestDistance) {
    bestDistance = distanceToNextWhole;
    bestText = String(whole + 1);
  }

  for (const candidate of fractionCandidates) {
    const distance = Math.abs(fraction - candidate.value);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestText = whole > 0 ? `${whole} ${candidate.label}` : candidate.label;
    }
  }

  return bestDistance <= tolerance ? bestText : null;
};

const formatVulgarFraction = (value: number): string =>
  tryVulgarFraction(value) ?? formatDecimal(value);

const isRange = (value: Exclude<ParsedQuantityValue, null>): value is { min: number; max: number } =>
  typeof value !== "number";

const formatMeasuredQuantity = (value: Exclude<ParsedQuantityValue, null>, unit: string | null): string => {
  const definition = unit ? unitAliasLookup.get(unit.toLowerCase()) : undefined;
  const formatter = definition?.fractional ? formatVulgarFraction : formatDecimal;

  if (!isRange(value)) {
    return formatter(value);
  }

  // A range reads as a single measurement, so both ends share one notation.
  // Formatting them independently let one end fall back to a decimal while the
  // other kept a fraction ("0.08–⅙ tsp"); when either end has no close
  // fraction, both fall back. Ends that render alike collapse to one value so
  // a narrowed range does not print as "⅛–⅛".
  const fractionMin = definition?.fractional ? tryVulgarFraction(value.min) : null;
  const fractionMax = definition?.fractional ? tryVulgarFraction(value.max) : null;
  const useFractions = fractionMin != null && fractionMax != null;
  const minText = useFractions ? fractionMin : formatDecimal(value.min);
  const maxText = useFractions ? fractionMax : formatDecimal(value.max);

  return minText === maxText ? minText : `${minText}–${maxText}`;
};

const formatWholeQuantity = (value: Exclude<ParsedQuantityValue, null>): string => {
  const min = isRange(value) ? value.min : value;
  const max = isRange(value) ? value.max : value;

  if (Number.isInteger(min) && Number.isInteger(max)) {
    return min === max ? String(min) : `${min}–${max}`;
  }

  if (max < 1) {
    // Rounding up to 1 here would leave a halved line looking unscaled, so
    // report the real amount instead ("½ can").
    return min === max
      ? formatVulgarFraction(max)
      : `${formatVulgarFraction(min)}–${formatVulgarFraction(max)}`;
  }

  const roundedMin = Math.max(1, Math.floor(min));
  const roundedMax = Math.max(1, Math.ceil(max));
  return roundedMin === roundedMax ? String(roundedMin) : `${roundedMin}–${roundedMax}`;
};

/**
 * Reads back the number that was actually rendered, so pluralization agrees
 * with the text on screen (1.05 cups renders as "1", so it reads "1 cup").
 */
const displayedValue = (quantityText: string, fallback: Exclude<ParsedQuantityValue, null>): number => {
  const lastSegment = quantityText.split(/[–—]/).pop() ?? quantityText;
  const parsed = parseNumberPhrase(lastSegment.trim());

  if (parsed != null) {
    return parsed;
  }

  return isRange(fallback) ? fallback.max : fallback;
};

const formatUnit = (unit: string, displayValue: number): string => {
  const definition = unitAliasLookup.get(unit.toLowerCase());

  if (!definition) {
    return unit;
  }

  if (definition.compact) {
    return definition.compact;
  }

  return displayValue <= 1 ? definition.singular : definition.plural;
};

const shouldUseWholeRange = (parsed: ParsedIngredientQuantity): boolean => {
  if (parsed.unit == null) {
    return true;
  }

  const definition = unitAliasLookup.get(parsed.unit.toLowerCase());
  return definition?.whole ?? false;
};

const maxOf = (value: Exclude<ParsedQuantityValue, null>): number =>
  isRange(value) ? value.max : value;

/**
 * Parses a leading ingredient quantity, optional unit, optional bracketed
 * alternate quantity, and the remaining item text.
 *
 * Lines without a clear leading quantity return the original line as `item`
 * with `confident:false`, which lets scaling callers skip them safely. A line
 * that is nothing but an amount ("2 cups") still parses confidently as long as
 * it carries a unit, so it scales with the rest of the recipe. A zero amount is
 * treated as unconfident: there is nothing meaningful to scale.
 */
export const parseIngredientQuantity = (text: string): ParsedIngredientQuantity => {
  const parsedQuantity = parseQuantityValue(text);

  if (!parsedQuantity) {
    return unconfident(text);
  }

  if (maxOf(parsedQuantity.value) <= 0) {
    return unconfident(text);
  }

  const unit = parseUnit(parsedQuantity.rest);
  const alt = parseAltQuantity(unit?.rest ?? parsedQuantity.rest);
  const item = alt.rest.trim();

  if (!item && !unit) {
    return unconfident(text);
  }

  return {
    qty: parsedQuantity.value,
    unit: unit?.definition.canonical ?? null,
    altQty: alt.qty,
    altUnit: alt.unit,
    item,
    confident: true
  };
};

/**
 * Renders a scaled ingredient line from a parsed quantity.
 *
 * Cup and spoon measurements use vulgar fractions; whole foods use rounded
 * ranges when scaling would otherwise create absurd output such as 1.33 eggs.
 * Factors are clamped to a usable range, and a nonsensical factor falls back to
 * 1 so the line keeps its amount rather than losing it.
 */
export const scaleQuantity = (parsed: ParsedIngredientQuantity, factor: number): string => {
  if (!parsed.confident || parsed.qty == null) {
    return parsed.item;
  }

  const safeFactor =
    Number.isFinite(factor) && factor > 0
      ? Math.min(maxScaleFactor, Math.max(minScaleFactor, factor))
      : 1;

  const scaledQty = scaleValue(parsed.qty, safeFactor);
  const quantityText = shouldUseWholeRange(parsed)
    ? formatWholeQuantity(scaledQty)
    : formatMeasuredQuantity(scaledQty, parsed.unit);
  const unitText = parsed.unit
    ? ` ${formatUnit(parsed.unit, displayedValue(quantityText, scaledQty))}`
    : "";
  const altText =
    parsed.altQty != null && parsed.altUnit
      ? ` [${formatMeasuredQuantity(scaleValue(parsed.altQty, safeFactor), parsed.altUnit)} ${parsed.altUnit}]`
      : "";

  return `${quantityText}${unitText}${altText} ${parsed.item}`.trim();
};
