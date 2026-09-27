/**
 * US ↔ metric conversion for ingredient lines, with friendly rounding and sensible units.
 *
 * - Volume (tsp, Tbsp, cup, fl oz, pt, qt, gal ↔ ml, l) and weight (oz, lb ↔ g, kg) convert
 *   exactly; count units (egg, clove, can, pinch, slice) never change.
 * - Units are promoted and demoted to what a cook would write: 3 tsp → 1 Tbsp, 16 Tbsp → 1 cup,
 *   ¼ cup → 4 Tbsp, 1000 g → 1 kg, 0.25 lb → 4 oz.
 * - Rounding is friendly: US amounts snap to eighths and thirds; metric amounts round to 5 g/ml
 *   under 100, 10 above, and 3 significant digits in kg/l.
 * - With the density table (on by default for metric), cups of baking staples become grams.
 *   Those results are flagged `approximate`.
 * - An author's own alternate amount ("2 cups [280 g]", "3 cups (360g)") always wins over a
 *   computed conversion.
 */
import {
  displayedValue,
  formatUnitLabel,
  formatValue,
  isRangeValue,
  maxOfValue,
  scaleValue
} from "./format-internal.js";
import {
  formatAmountWithUnit,
  formatParsedIngredient,
  parseIngredientQuantity,
  scaleQuantity
} from "./ingredient-quantities.js";
import {
  G_PER_OZ,
  getUnitDefinition,
  ML_PER_CUP,
  ML_PER_GALLON,
  ML_PER_QUART,
  ML_PER_TBSP,
  ML_PER_TSP
} from "./units.js";

import type { QuantityValue } from "./format-internal.js";
import type { IngredientPackageSize, ParsedIngredientQuantity } from "./ingredient-quantities.js";
import type { UnitDefinition } from "./units.js";

export type MeasurementSystem = "us" | "metric";
export type IngredientUnitsPreference = "original" | MeasurementSystem;

export type IngredientDensity = {
  /** Stable key of the density entry ("flour", "brown-sugar"). */
  key: string;
  gramsPerCup: number;
  /** Metric recipes weigh this ingredient (flour, butter) rather than measuring it (milk, oil). */
  preferMass: boolean;
};

export type ConvertIngredientOptions = {
  /** Multiplier applied before converting (clamped to 0.05–50 like `scaleQuantity`). */
  scale?: number | undefined;
  /**
   * Allow volume ↔ weight through the density table. Defaults to true for metric (cups of flour
   * become grams) and false for US (grams stay weights, as ounces or pounds).
   */
  useDensity?: boolean | undefined;
};

export type ConvertedIngredient = {
  /** The rendered line. */
  text: string;
  /** The scaled, converted parse behind `text`. */
  parsed: ParsedIngredientQuantity;
  /** False for lines without a readable amount; `text` is then the line as written. */
  confident: boolean;
  /** True when the text differs from the plain scaled line (a unit or amount was converted). */
  converted: boolean;
  /** True when a volume ↔ weight conversion used the density table. */
  approximate: boolean;
};

export type DisplayIngredientOptions = {
  scale?: number | undefined;
  units?: IngredientUnitsPreference | undefined;
  /**
   * Return the line exactly as written when nothing changes (scale 1, original units). By
   * default the line is re-rendered with normalized units ("3 tablespoons" → "3 Tbsp"), which is
   * what the web cook mode has always shown.
   */
  keepOriginalText?: boolean | undefined;
};

export type DisplayIngredient = {
  text: string;
  confident: boolean;
  /** The amount was multiplied (scale ≠ 1 and the line had an amount). */
  scaled: boolean;
  converted: boolean;
  approximate: boolean;
};

const BUTTER_PATTERN = /\b(?:butter|margarine)\b/i;
const MIN_SCALE = 0.05;
const MAX_SCALE = 50;
const EPSILON = 1e-9;
const G_PER_STICK_BUTTER = G_PER_OZ * 4;
const ML_PER_QUARTER_CUP = ML_PER_CUP / 4;

const clampScale = (factor: number): number =>
  Number.isFinite(factor) && factor > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, factor)) : 1;

/**
 * Grams per US cup for common staples, most specific first. Each pattern is compiled once and
 * guards against look-alikes ("sugar snap peas", "rice vinegar", "butter beans").
 */
const DENSITY_TABLE: ReadonlyArray<IngredientDensity & { pattern: RegExp }> = [
  { key: "almond-flour", pattern: /\balmond (?:flour|meal)\b/i, gramsPerCup: 96, preferMass: true },
  { key: "coconut-flour", pattern: /\bcoconut flour\b/i, gramsPerCup: 112, preferMass: true },
  {
    key: "whole-wheat-flour",
    pattern: /\bwhole[- ]wheat flour\b/i,
    gramsPerCup: 113,
    preferMass: true
  },
  {
    key: "flour",
    pattern: /\bflour\b(?!\s*tortillas?)/i,
    gramsPerCup: 120,
    preferMass: true
  },
  {
    key: "powdered-sugar",
    pattern: /\b(?:powdered|confectioners'?|icing) sugar\b/i,
    gramsPerCup: 113,
    preferMass: true
  },
  { key: "brown-sugar", pattern: /\bbrown sugar\b/i, gramsPerCup: 213, preferMass: true },
  {
    key: "sugar",
    pattern: /\bsugar\b(?!\s*(?:snap|free|syrup))/i,
    gramsPerCup: 200,
    preferMass: true
  },
  {
    key: "nut-butter",
    pattern: /\b(?:peanut|almond|cashew) butter\b/i,
    gramsPerCup: 250,
    preferMass: true
  },
  {
    key: "butter",
    pattern: /\bbutter\b(?!\s*(?:beans?|lettuce|milk|nut|scotch|cream))/i,
    gramsPerCup: 227,
    preferMass: true
  },
  {
    key: "rice",
    pattern:
      /^(?!.*\bcooked\b)(?=.*\brice\b(?!\s*(?:vinegar|wine|noodles?|paper|krispies|cakes?|flour|milk|syrup)))/i,
    gramsPerCup: 190,
    preferMass: true
  },
  {
    key: "oats",
    pattern: /\b(?:rolled |old[- ]fashioned |quick |steel[- ]cut )?oats\b(?!\s*milk)/i,
    gramsPerCup: 90,
    preferMass: true
  },
  { key: "cocoa", pattern: /\bcocoa powder\b|\bcocoa\b/i, gramsPerCup: 85, preferMass: true },
  {
    key: "chocolate-chips",
    pattern: /\bchocolate (?:chips|chunks)\b/i,
    gramsPerCup: 170,
    preferMass: true
  },
  { key: "honey", pattern: /\bhoney\b/i, gramsPerCup: 340, preferMass: true },
  { key: "maple-syrup", pattern: /\bmaple syrup\b/i, gramsPerCup: 312, preferMass: false },
  { key: "yogurt", pattern: /\b(?:greek )?yogh?urt\b/i, gramsPerCup: 245, preferMass: true },
  { key: "buttermilk", pattern: /\bbuttermilk\b/i, gramsPerCup: 242, preferMass: false },
  {
    key: "milk",
    pattern: /\bmilk\b(?!\s*chocolate)/i,
    gramsPerCup: 242,
    preferMass: false
  },
  {
    key: "water",
    pattern: /\bwater\b(?!\s*chestnuts?)/i,
    gramsPerCup: 237,
    preferMass: false
  },
  {
    key: "oil",
    pattern: /\boil\b(?!-packed|\s*packed)/i,
    gramsPerCup: 218,
    preferMass: false
  }
];

/** Density for an ingredient name, or null when the table has no confident match. */
export const findIngredientDensity = (ingredientText: string): IngredientDensity | null => {
  for (const entry of DENSITY_TABLE) {
    if (entry.pattern.test(ingredientText)) {
      return { key: entry.key, gramsPerCup: entry.gramsPerCup, preferMass: entry.preferMass };
    }
  }

  return null;
};

/** The density keys the converter knows, for UI copy ("Approximate for flour, sugar…"). */
export const INGREDIENT_DENSITY_KEYS: readonly string[] = DENSITY_TABLE.map((entry) => entry.key);

// --- Friendly rounding ---------------------------------------------------------------------

const US_FRACTIONS = [0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1];
const QUARTERS = [0, 1 / 4, 1 / 2, 3 / 4, 1];
const HALVES = [0, 1 / 2, 1];

const snap = (value: number, fractions: readonly number[]): number => {
  const whole = Math.floor(value);
  const fraction = value - whole;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of fractions) {
    const distance = Math.abs(fraction - candidate);

    if (distance < bestDistance - EPSILON) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return whole + best;
};

const smallestPositive = (fractions: readonly number[]): number =>
  fractions.find((fraction) => fraction > 0) ?? 1;

/** US amounts snap to friendly fractions: eighths and thirds, halves above 10, never zero. */
const roundUs = (value: number, unit: string): number => {
  let fractions: readonly number[] = US_FRACTIONS;

  if (unit === "lb") {
    fractions = QUARTERS;
  } else if (unit === "oz") {
    fractions = value < 1 ? US_FRACTIONS : value < 4 ? QUARTERS : HALVES;
  } else if (value >= 10) {
    fractions = HALVES;
  }

  const snapped = snap(value, fractions);
  return snapped > 0 ? snapped : smallestPositive(fractions);
};

const roundToStep = (value: number, step: number): number => Math.round(value / step) * step;

const roundSignificant = (value: number, digits: number): number =>
  value === 0 ? 0 : Number(value.toPrecision(digits));

/** Metric amounts: 5 g/ml steps under 100, 10 above; kg and l keep 3 significant digits. */
const roundMetric = (value: number, unit: string): number => {
  if (unit === "kg" || unit === "l") {
    return roundSignificant(value, 3);
  }

  if (unit === "mg" || unit === "cl" || unit === "dl") {
    return roundSignificant(value, 2);
  }

  if (value < 1) {
    return Math.max(0.1, roundToStep(value, 0.1));
  }

  if (value < 5) {
    return roundToStep(value, 0.5);
  }

  if (value < 10) {
    return Math.round(value);
  }

  return value < 100 ? roundToStep(value, 5) : roundToStep(value, 10);
};

const mapValue = (value: QuantityValue, map: (end: number) => number): QuantityValue => {
  if (!isRangeValue(value)) {
    return map(value);
  }

  const min = map(value.min);
  const max = map(value.max);
  return min === max ? min : { min, max };
};

// --- Unit ladders --------------------------------------------------------------------------

type Converted = { value: QuantityValue; unit: string; approximate: boolean };

/** Picks the US volume unit a cook would use for an amount in millilitres. */
const pickUsVolumeUnit = (ml: number): { unit: string; base: number } => {
  if (ml < ML_PER_TBSP - EPSILON) {
    return { unit: "tsp", base: ML_PER_TSP };
  }

  if (ml <= ML_PER_QUARTER_CUP + EPSILON) {
    return { unit: "Tbsp", base: ML_PER_TBSP };
  }

  if (ml <= ML_PER_CUP * 8 + EPSILON) {
    return { unit: "cup", base: ML_PER_CUP };
  }

  return ml < ML_PER_GALLON - EPSILON
    ? { unit: "qt", base: ML_PER_QUART }
    : { unit: "gal", base: ML_PER_GALLON };
};

const toUsVolume = (ml: QuantityValue): Converted => {
  const { unit, base } = pickUsVolumeUnit(maxOfValue(ml));
  const value = mapValue(ml, (end) => roundUs(end / base, unit));

  // Snapping can land on the next unit's threshold (2.95 tsp → 3 tsp); re-pick from there.
  if (unit === "tsp" && maxOfValue(value) >= 3) {
    return toUsVolume(mapValue(ml, (end) => end));
  }

  return { value, unit, approximate: false };
};

/**
 * Converts from a base amount (grams or millilitres) to the smaller unit, or to the larger one
 * when the amount — before or after rounding — reaches it (15.9 oz rounds to 16 oz → 1 lb;
 * 996 g rounds to 1000 g → 1 kg).
 */
const toSmallOrLarge = (
  base: QuantityValue,
  small: { unit: string; base: number },
  large: { unit: string; base: number },
  round: (value: number, unit: string) => number
): Converted => {
  const threshold = large.base / small.base;

  if (maxOfValue(base) / small.base < threshold - EPSILON) {
    const value = mapValue(base, (end) => round(end / small.base, small.unit));

    if (maxOfValue(value) < threshold - EPSILON) {
      return { value, unit: small.unit, approximate: false };
    }
  }

  return {
    value: mapValue(base, (end) => round(end / large.base, large.unit)),
    unit: large.unit,
    approximate: false
  };
};

const toUsMass = (grams: QuantityValue): Converted =>
  toSmallOrLarge(
    grams,
    { unit: "oz", base: G_PER_OZ },
    { unit: "lb", base: G_PER_OZ * 16 },
    roundUs
  );

const toMetricVolume = (ml: QuantityValue): Converted =>
  toSmallOrLarge(ml, { unit: "ml", base: 1 }, { unit: "l", base: 1000 }, roundMetric);

const toMetricMass = (grams: QuantityValue): Converted =>
  toSmallOrLarge(grams, { unit: "g", base: 1 }, { unit: "kg", base: 1000 }, roundMetric);

/**
 * The range of amounts in which a unit is kept as written in its own system. Outside it the
 * amount moves to a better unit: 3 tsp → 1 Tbsp, 16 Tbsp → 1 cup, ¼ cup → 4 Tbsp,
 * 16 oz → 1 lb, 0.25 lb → 4 oz, 1000 g → 1 kg.
 */
const KEEP_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  tsp: [1 / 8, 3],
  Tbsp: [1, 16],
  // Exclusive at ¼ cup: a quarter cup reads better as 4 Tbsp.
  cup: [1 / 4 + 1e-6, Number.POSITIVE_INFINITY],
  "fl oz": [1, 32],
  pt: [1, 4],
  qt: [1, 16],
  gal: [1, Number.POSITIVE_INFINITY],
  oz: [0, 16],
  lb: [1, Number.POSITIVE_INFINITY],
  g: [0, 1000],
  kg: [1, Number.POSITIVE_INFINITY],
  ml: [0, 1000],
  l: [1, Number.POSITIVE_INFINITY],
  cl: [0, Number.POSITIVE_INFINITY],
  dl: [0, Number.POSITIVE_INFINITY],
  mg: [0, 1000]
};

const isWithinKeepRange = (value: QuantityValue, unit: string): boolean => {
  const range = KEEP_RANGES[unit];

  if (!range) {
    return true;
  }

  const low = isRangeValue(value) ? value.min : value;
  const high = maxOfValue(value);
  return low >= range[0] - EPSILON && high < range[1] - EPSILON;
};

const toBase = (value: QuantityValue, definition: UnitDefinition): QuantityValue =>
  scaleValue(value, definition.base ?? 1);

const isSpoon = (definition: UnitDefinition): boolean =>
  definition.canonical === "tsp" || definition.canonical === "Tbsp";

/**
 * Converts one amount to the target system. Returns null when the amount should stay exactly as
 * written (already in the target system, in a comfortable unit, and not rescaled).
 */
const convertAmount = (
  value: QuantityValue,
  definition: UnitDefinition,
  target: MeasurementSystem,
  context: { ingredient: string; useDensity: boolean; rescaled: boolean }
): Converted | null => {
  if (definition.kind === "count") {
    const isButterStick =
      definition.canonical === "stick" && BUTTER_PATTERN.test(context.ingredient);

    return target === "metric" && isButterStick
      ? toMetricMass(scaleValue(value, G_PER_STICK_BUTTER))
      : null;
  }

  const base = toBase(value, definition);
  // Metric cooks use spoons too (a metric teaspoon is 5 ml), so small spoon amounts stay spoons.
  const staysSpoon =
    target === "metric" && isSpoon(definition) && maxOfValue(base) < ML_PER_QUARTER_CUP - EPSILON;
  const inTargetSystem = definition.system === target || staysSpoon;

  if (inTargetSystem) {
    if (isWithinKeepRange(value, definition.canonical)) {
      if (!context.rescaled) {
        return null;
      }

      const round = definition.system === "metric" ? roundMetric : roundUs;
      return {
        value: mapValue(value, (end) => round(end, definition.canonical)),
        unit: definition.canonical,
        approximate: false
      };
    }

    if (staysSpoon) {
      return toUsVolume(base);
    }

    if (definition.kind === "volume") {
      return target === "us" ? toUsVolume(base) : toMetricVolume(base);
    }

    return target === "us" ? toUsMass(base) : toMetricMass(base);
  }

  const density = context.useDensity ? findIngredientDensity(context.ingredient) : null;

  if (definition.kind === "volume") {
    if (target === "us") {
      return toUsVolume(base);
    }

    if (density?.preferMass) {
      const grams = scaleValue(base, density.gramsPerCup / ML_PER_CUP);
      return { ...toMetricMass(grams), approximate: true };
    }

    return toMetricVolume(base);
  }

  if (target === "metric") {
    return toMetricMass(base);
  }

  if (density) {
    return { ...toUsVolume(scaleValue(base, ML_PER_CUP / density.gramsPerCup)), approximate: true };
  }

  return toUsMass(base);
};

const METRIC_DECIMALS_PATTERN = /\.?0+$/u;

const formatMetricNumber = (value: number): string => {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(2).replace(METRIC_DECIMALS_PATTERN, "");
};

const US_FRACTIONAL_WEIGHT_UNITS = new Set(["oz", "lb"]);

/**
 * How converted amounts print: metric as trimmed decimals ("1.25 kg", "375 g"), and ounces and
 * pounds in US mode as fractions ("1 ¼ lb") because they were snapped to quarters. Everything
 * else uses the regular rules (cups and spoons print fractions). Null means "use the default".
 */
const formatAmountForTarget =
  (target: MeasurementSystem) =>
  (value: QuantityValue, definition: UnitDefinition): string | null => {
    if (definition.kind === "count") {
      return null;
    }

    // Only metric amounts the converter produced (metric target) were rounded for display;
    // metric alternates kept while showing US units print like any scaled amount.
    if (definition.system === "metric" && target === "metric") {
      if (!isRangeValue(value)) {
        return formatMetricNumber(value);
      }

      const min = formatMetricNumber(value.min);
      const max = formatMetricNumber(value.max);
      return min === max ? min : `${min}–${max}`;
    }

    return target === "us" && US_FRACTIONAL_WEIGHT_UNITS.has(definition.canonical)
      ? formatValue(value, true)
      : null;
  };

const formatConvertedWithUnit = (
  value: QuantityValue,
  unit: string,
  target: MeasurementSystem
): string => {
  const definition = getUnitDefinition(unit);
  const custom = definition ? formatAmountForTarget(target)(value, definition) : null;

  if (custom == null) {
    return formatAmountWithUnit(value, unit);
  }

  return `${custom} ${formatUnitLabel(unit, displayedValue(custom, value))}`;
};

/** Package sizes are labels, so they keep label precision (15 oz → 425 g, 400 g → 14 oz). */
const convertPackageSize = (
  packageSize: IngredientPackageSize,
  target: MeasurementSystem
): IngredientPackageSize | null => {
  const definition = getUnitDefinition(packageSize.unit);

  if (!definition || definition.kind === "count" || definition.system === target) {
    return null;
  }

  const base = toBase(packageSize.qty, definition);
  let converted: Converted;

  if (target === "metric") {
    const unit =
      definition.kind === "volume"
        ? maxOfValue(base) < 1000
          ? "ml"
          : "l"
        : maxOfValue(base) < 1000
          ? "g"
          : "kg";
    const divisor = unit === "l" || unit === "kg" ? 1000 : 1;
    converted = {
      value: mapValue(base, (end) =>
        divisor === 1 ? Math.round(end) : roundSignificant(end / divisor, 3)
      ),
      unit,
      approximate: false
    };
  } else {
    converted = definition.kind === "volume" ? toUsVolume(base) : toUsMass(base);
  }

  return {
    ...packageSize,
    text: formatConvertedWithUnit(converted.value, converted.unit, target),
    qty: converted.value,
    unit: converted.unit,
    style: packageSize.style === "bare" ? "paren" : packageSize.style
  };
};

/**
 * Converts a parsed ingredient line to US or metric units (see the module notes for the rules).
 * Lines without a readable amount come back verbatim with `confident: false`.
 */
export const convertParsedQuantity = (
  parsed: ParsedIngredientQuantity,
  target: MeasurementSystem,
  options: ConvertIngredientOptions = {}
): ConvertedIngredient => {
  if (!parsed.confident || parsed.qty == null) {
    return { text: parsed.item, parsed, confident: false, converted: false, approximate: false };
  }

  const factor = clampScale(options.scale ?? 1);
  const baseline = scaleQuantity(parsed, factor);
  const useDensity = options.useDensity ?? target === "metric";
  const rescaled = factor !== 1;
  const primaryDefinition = getUnitDefinition(parsed.unit);
  const altDefinition = getUnitDefinition(parsed.altUnit);
  const qty = scaleValue(parsed.qty, factor);
  const altQty = parsed.altQty == null ? null : scaleValue(parsed.altQty, factor);

  let result: ParsedIngredientQuantity = { ...parsed, qty, altQty };
  let approximate = false;

  const primaryInTarget = primaryDefinition?.system === target;
  const altInTarget = altDefinition != null && altQty != null && altDefinition.system === target;

  // Counts swap too ("1 stick (113g) butter" → "113 g butter"), as the old alternate toggle did.
  if (!primaryInTarget && altInTarget) {
    // The author's own amount in the target system beats any computed conversion.
    const promoted = convertAmount(altQty, altDefinition, target, {
      ingredient: parsed.item,
      useDensity: false,
      rescaled
    });
    result = {
      ...result,
      qty: promoted?.value ?? altQty,
      unit: promoted?.unit ?? altDefinition.canonical,
      altQty: null,
      altUnit: null,
      altStyle: undefined,
      // The alternate covers the whole amount, including "plus 2 tablespoons".
      addition: undefined
    };
  } else if (primaryDefinition) {
    // "1 cup plus 2 tablespoons" converts as one amount (1 ⅛ cups → 135 g).
    const additionDefinition = getUnitDefinition(parsed.addition?.unit);
    const foldedQty =
      parsed.addition && additionDefinition?.base && primaryDefinition.base
        ? mapValue(
            qty,
            (end) =>
              end +
              ((parsed.addition?.qty ?? 0) * factor * (additionDefinition.base ?? 0)) /
                (primaryDefinition.base ?? 1)
          )
        : qty;
    const converted = convertAmount(foldedQty, primaryDefinition, target, {
      ingredient: parsed.item,
      useDensity,
      rescaled
    });

    if (converted) {
      const unitChanged = converted.unit !== primaryDefinition.canonical;
      approximate = converted.approximate;
      result = {
        ...result,
        qty: converted.value,
        unit: converted.unit,
        addition: undefined,
        // Once the main amount is in the target system, an alternate in the other one is noise.
        ...(unitChanged && !primaryInTarget && altDefinition && altDefinition.system !== target
          ? { altQty: null, altUnit: null, altStyle: undefined }
          : {})
      };
    }
  }

  if (result.packageSize) {
    const packageSize = convertPackageSize(result.packageSize, target);

    if (packageSize) {
      result = { ...result, packageSize };
    }
  }

  const text = formatParsedIngredient(result, {
    factor: 1,
    writtenCount: maxOfValue(parsed.qty),
    formatAmount: formatAmountForTarget(target),
    transformEmbeddedAmount: (value, definition, context) => {
      const scaledValue = scaleValue(value, factor);
      // "¼ cup (50g) oil": the bracketed weight is the cup's alternate, so it only scales.
      const embedded = context.isAlternate
        ? null
        : convertAmount(scaledValue, definition, target, {
            ingredient: "",
            useDensity: false,
            rescaled
          });

      if (embedded) {
        return formatConvertedWithUnit(embedded.value, embedded.unit, target);
      }

      return rescaled ? formatAmountWithUnit(scaledValue, definition.canonical) : null;
    }
  });

  return {
    text,
    parsed: result,
    confident: true,
    converted: text !== baseline,
    approximate
  };
};

/** Parses and converts one ingredient line; see `convertParsedQuantity`. */
export const convertIngredientLine = (
  text: string,
  target: MeasurementSystem,
  options: ConvertIngredientOptions = {}
): ConvertedIngredient => {
  const parsed = parseIngredientQuantity(text);
  const converted = convertParsedQuantity(parsed, target, options);
  return converted.confident ? converted : { ...converted, text };
};

/**
 * The one helper the apps use to show an ingredient line: scaled by `scale` and shown in the
 * original, US or metric units. For `units: "original"` this is exactly the cook mode's
 * long-standing output (`scaleQuantity` of the parsed line, including bracketed and
 * parenthetical alternates); lines without an amount always come back as written.
 */
export const getDisplayIngredient = (
  text: string,
  options: DisplayIngredientOptions = {}
): DisplayIngredient => {
  const scale = options.scale ?? 1;
  const units = options.units ?? "original";
  const parsed = parseIngredientQuantity(text);

  if (!parsed.confident) {
    return { text, confident: false, scaled: false, converted: false, approximate: false };
  }

  const scaled = clampScale(scale) !== 1;

  if (units === "original") {
    return {
      text: options.keepOriginalText && !scaled ? text : scaleQuantity(parsed, scale),
      confident: true,
      scaled,
      converted: false,
      approximate: false
    };
  }

  const converted = convertParsedQuantity(parsed, units, { scale });

  return {
    text: options.keepOriginalText && !scaled && !converted.converted ? text : converted.text,
    confident: true,
    scaled,
    converted: converted.converted,
    approximate: converted.approximate
  };
};

/** `getDisplayIngredient(...).text`. */
export const getDisplayIngredientText = (
  text: string,
  options: DisplayIngredientOptions = {}
): string => getDisplayIngredient(text, options).text;

export type IngredientUnitSummary = {
  /** Lines whose main amount is in US units (cups, spoons, ounces, pounds...). */
  usLines: number;
  /** Lines whose main amount is in metric units. */
  metricLines: number;
  /** The system most measured lines use, or null when no line has a measured unit. */
  primarySystem: MeasurementSystem | null;
  /** Some line carries an author-provided alternate amount ("3 cups (360g)"). */
  hasAlternateAmounts: boolean;
  /** Some line has no readable amount ("Salt to taste"), so it will not scale. */
  hasUnscalableLines: boolean;
  /** Showing US or metric would change at least one line. */
  canConvert: boolean;
};

/**
 * One pass over a recipe's ingredient lines for the scale/unit controls: which systems the
 * recipe uses, whether any line has an alternate amount or cannot scale, and whether a unit
 * toggle would change anything.
 */
export const getIngredientUnitSummary = (
  ingredients: ReadonlyArray<string | { text: string }>
): IngredientUnitSummary => {
  let usLines = 0;
  let metricLines = 0;
  let hasAlternateAmounts = false;
  let hasUnscalableLines = false;

  for (const ingredient of ingredients) {
    const parsed = parseIngredientQuantity(
      typeof ingredient === "string" ? ingredient : ingredient.text
    );

    if (!parsed.confident) {
      hasUnscalableLines = true;
      continue;
    }

    hasAlternateAmounts ||= parsed.altQty != null && parsed.altUnit != null;
    const system = getUnitDefinition(parsed.unit)?.system;

    if (system === "us") {
      usLines += 1;
    } else if (system === "metric") {
      metricLines += 1;
    }
  }

  const primarySystem =
    usLines === 0 && metricLines === 0 ? null : usLines >= metricLines ? "us" : "metric";

  return {
    usLines,
    metricLines,
    primarySystem,
    hasAlternateAmounts,
    hasUnscalableLines,
    canConvert: usLines > 0 || metricLines > 0
  };
};

// --- Temperatures ----------------------------------------------------------------------------

const DEGREE = String.raw`(?:°|º|˚|\s?degrees?|\s?deg\.?)`;
/** Value (and optional range end), then a marked scale ("°F", "degrees C") or a bare letter. */
const TEMPERATURE_BODY =
  String.raw`(-?\d{1,3})(?:\s*(?:-|–|—|to)\s*(-?\d{1,3}))?` +
  String.raw`(?:\s*${DEGREE}\s*(F|C|Fahrenheit|Celsius|Centigrade)\b|\s?(F|C)\b(?![°'’-]))`;
/** "350°F", "350 degrees F", "350-375°F", "180 °C", "180C", "350 F", "-18°C". Gas marks never match. */
const TEMPERATURE_PATTERN = new RegExp(String.raw`(?<![\w.])${TEMPERATURE_BODY}`, "gi");
/** "350°F (175°C)" or "180°C/350°F": the same temperature given in both scales. */
const TEMPERATURE_PAIR_PATTERN = new RegExp(
  String.raw`(?<![\w.])${TEMPERATURE_BODY}\s*(?:\(\s*|/\s*|or\s+)${TEMPERATURE_BODY}\s*\)?`,
  "gi"
);

const fahrenheitToCelsius = (fahrenheit: number): number => {
  const celsius = ((fahrenheit - 32) * 5) / 9;
  // Oven temperatures round to 5°C like oven dials; food and sugar temperatures stay precise.
  return fahrenheit >= 250 ? roundToStep(celsius, 5) : Math.round(celsius);
};

const celsiusToFahrenheit = (celsius: number): number => {
  const fahrenheit = (celsius * 9) / 5 + 32;
  // Oven temperatures round to 25°F (180°C → 350°F); food temperatures stay precise.
  return celsius >= 120 ? roundToStep(fahrenheit, 25) : Math.round(fahrenheit);
};

const scaleOf = (letter: string | undefined): "F" | "C" | null => {
  const first = letter?.charAt(0).toUpperCase();
  return first === "F" ? "F" : first === "C" ? "C" : null;
};

/**
 * A bare letter ("350 F", "180 C") only means degrees for oven-range numbers; "12 C" is more
 * likely twelve cups.
 */
const isPlausibleBareTemperature = (value: number): boolean => value >= 100;

/**
 * Rewrites oven and food temperatures in step text to the target system: "350°F" ↔ "175°C",
 * "350 degrees F" → "175°C", "350-375°F" → "175–190°C". A temperature already given in both
 * scales ("350°F (175°C)") keeps just the target one. Gas marks and bare "350 degrees" (no
 * scale) are left untouched, as is anything already in the target system.
 */
export const convertTemperaturesInText = (text: string, target: MeasurementSystem): string => {
  const targetScale = target === "metric" ? "C" : "F";
  const render = (first: number, second: number | null, scale: "F" | "C"): string => {
    const convert = scale === "F" ? fahrenheitToCelsius : celsiusToFahrenheit;
    const low = convert(first);
    const high = second == null ? null : convert(second);
    return high == null || high === low
      ? `${low}°${targetScale}`
      : `${Math.min(low, high)}–${Math.max(low, high)}°${targetScale}`;
  };

  const withoutPairs = text.replace(
    TEMPERATURE_PAIR_PATTERN,
    (match: string, ...groups: Array<string | undefined>) => {
      const firstScale = scaleOf(groups[2] ?? groups[3]);
      const secondScale = scaleOf(groups[6] ?? groups[7]);

      if (!firstScale || !secondScale || firstScale === secondScale) {
        return match;
      }

      const keepFirst = firstScale === targetScale;
      const value = keepFirst ? groups[0] : groups[4];
      const upper = keepFirst ? groups[1] : groups[5];
      return upper ? `${value}–${upper}°${targetScale}` : `${value}°${targetScale}`;
    }
  );

  return withoutPairs.replace(
    TEMPERATURE_PATTERN,
    (
      match: string,
      firstText: string,
      secondText: string | undefined,
      markedScale: string | undefined,
      bareScale: string | undefined
    ) => {
      const scale = scaleOf(markedScale ?? bareScale);
      const first = Number(firstText);
      const second = secondText == null ? null : Number(secondText);

      if (!scale || scale === targetScale) {
        return match;
      }

      if (markedScale == null && !isPlausibleBareTemperature(first)) {
        return match;
      }

      return render(first, second, scale);
    }
  );
};
