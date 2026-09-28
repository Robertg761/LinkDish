/**
 * Number and unit rendering shared by the scaler, the converter and the shopping formatter.
 * Internal: index.ts does not re-export this module; the public surface is quantity-format.ts.
 */
import { inflectNoun } from "./inflection.js";
import { parseNumberPhrase } from "./number-phrases.js";
import { getUnitDefinition } from "./units.js";

export type QuantityValue = number | { min: number; max: number };

/**
 * Fractions the renderer is allowed to print, smallest first. Anything not in this list is
 * rendered as a decimal rather than snapped to a nearby fraction.
 */
export const FRACTION_CANDIDATES: ReadonlyArray<{ value: number; label: string }> = [
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
 * How far a value may sit from a printable fraction, relative to the value itself, before the
 * renderer gives up and prints a decimal. 1/16 keeps ordinary rounding (1.05 cups -> "1") while
 * refusing to call 1/16 tsp "⅛".
 */
const FRACTION_RELATIVE_TOLERANCE = 1 / 16;

const RANGE_SEPARATOR_PATTERN = /[–—]/u;

export const isRangeValue = (value: QuantityValue): value is { min: number; max: number } =>
  typeof value !== "number";

export const maxOfValue = (value: QuantityValue): number =>
  isRangeValue(value) ? value.max : value;

export const scaleValue = (value: QuantityValue, factor: number): QuantityValue =>
  isRangeValue(value) ? { min: value.min * factor, max: value.max * factor } : value * factor;

export const formatDecimal = (value: number): string => {
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

  // Small amounts keep two decimals so a scaled-down pinch stays honest ("0.06 tsp") instead of
  // rounding away to "0" or "0.1".
  const twoPlaces = Number(value.toFixed(2));
  return twoPlaces === 0 ? String(Number(value.toPrecision(1))) : String(twoPlaces);
};

/**
 * Renders a value using the fraction nearest to it, or null when no printable fraction is close
 * enough. Quantizing against an explicit candidate set (rather than rounding to eighths) is what
 * lets thirds and sixths survive.
 */
export const tryVulgarFraction = (value: number): string | null => {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  const rounded = Math.round(value);

  if (Math.abs(value - rounded) < 0.001) {
    return String(rounded);
  }

  const whole = Math.floor(value);
  const fraction = value - whole;
  const tolerance = value * FRACTION_RELATIVE_TOLERANCE;

  let bestDistance = fraction;
  let bestText = String(whole);

  const distanceToNextWhole = 1 - fraction;
  if (distanceToNextWhole < bestDistance) {
    bestDistance = distanceToNextWhole;
    bestText = String(whole + 1);
  }

  for (const candidate of FRACTION_CANDIDATES) {
    const distance = Math.abs(fraction - candidate.value);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestText = whole > 0 ? `${whole} ${candidate.label}` : candidate.label;
    }
  }

  return bestDistance <= tolerance ? bestText : null;
};

export const formatVulgarFraction = (value: number): string =>
  tryVulgarFraction(value) ?? formatDecimal(value);

/** Formats a value or range with fractions (`fractional`) or decimals; ends share one notation. */
export const formatValue = (value: QuantityValue, fractional: boolean): string => {
  if (!isRangeValue(value)) {
    return fractional ? formatVulgarFraction(value) : formatDecimal(value);
  }

  // A range reads as a single measurement, so both ends share one notation. Formatting them
  // independently let one end fall back to a decimal while the other kept a fraction
  // ("0.08–⅙ tsp"); when either end has no close fraction, both fall back. Ends that render
  // alike collapse to one value so a narrowed range does not print as "⅛–⅛".
  const fractionMin = fractional ? tryVulgarFraction(value.min) : null;
  const fractionMax = fractional ? tryVulgarFraction(value.max) : null;
  const useFractions = fractionMin != null && fractionMax != null;
  const minText = useFractions ? fractionMin : formatDecimal(value.min);
  const maxText = useFractions ? fractionMax : formatDecimal(value.max);

  return minText === maxText ? minText : `${minText}–${maxText}`;
};

export const formatMeasuredQuantity = (value: QuantityValue, unit: string | null): string =>
  formatValue(value, getUnitDefinition(unit)?.fractional ?? false);

/**
 * Whole foods and whole-item units round to integer ranges when scaling would otherwise create
 * absurd output such as 1.33 eggs; amounts below 1 keep their fraction ("½ can").
 */
export const formatWholeQuantity = (value: QuantityValue): string => {
  const min = isRangeValue(value) ? value.min : value;
  const max = isRangeValue(value) ? value.max : value;

  if (Number.isInteger(min) && Number.isInteger(max)) {
    return min === max ? String(min) : `${min}–${max}`;
  }

  if (max < 1) {
    // Rounding up to 1 here would leave a halved line looking unscaled, so report the real
    // amount instead ("½ can").
    return min === max
      ? formatVulgarFraction(max)
      : `${formatVulgarFraction(min)}–${formatVulgarFraction(max)}`;
  }

  const roundedMin = Math.max(1, Math.floor(min));
  const roundedMax = Math.max(1, Math.ceil(max));
  return roundedMin === roundedMax ? String(roundedMin) : `${roundedMin}–${roundedMax}`;
};

/**
 * Reads back the number that was actually rendered, so pluralization agrees with the text on
 * screen (1.05 cups renders as "1", so it reads "1 cup").
 */
export const displayedValue = (quantityText: string, fallback: QuantityValue): number => {
  const lastSegment = quantityText.split(RANGE_SEPARATOR_PATTERN).pop() ?? quantityText;
  const parsed = parseNumberPhrase(lastSegment.trim());

  if (parsed != null && lastSegment.trim().length > 0) {
    return parsed;
  }

  return maxOfValue(fallback);
};

/**
 * Unit label for a displayed amount: the compact label when the unit has one ("Tbsp", "g"),
 * otherwise singular or plural ("1 cup", "2 cans"). Unknown units are inflected as nouns.
 */
export const formatUnitLabel = (unit: string, displayValue: number): string => {
  const definition = getUnitDefinition(unit);

  if (!definition) {
    return inflectNoun(unit, displayValue);
  }

  if (definition.compact) {
    return definition.compact;
  }

  return displayValue <= 1 ? definition.singular : definition.plural;
};
