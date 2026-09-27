import {
  displayedValue,
  formatUnitLabel,
  formatValue,
  formatWholeQuantity,
  isRangeValue
} from "./format-internal.js";
import { getUnitDefinition } from "./units.js";

export type QuantityRange = { min: number; max: number };
export type FormattableQuantity = number | QuantityRange;

export type FormatQuantityOptions = {
  /**
   * "fraction" (default) prints the nearest friendly fraction ("⅔", "1 ½") and falls back to a
   * short decimal when no printable fraction is close; "decimal" always prints decimals.
   */
  style?: "fraction" | "decimal" | undefined;
};

export type FormatIngredientQuantityOptions = {
  /**
   * How to print amounts of whole items (no unit, or cans/cloves/pinches). "exact" (default)
   * keeps friendly fractions ("1 ½ cans"); "range" rounds to whole-number ranges like scaling
   * does ("1–2 cans").
   */
  wholeItems?: "exact" | "range" | undefined;
};

const isUsableNumber = (value: number): boolean => Number.isFinite(value) && value >= 0;

const isFormattable = (value: unknown): value is FormattableQuantity =>
  typeof value === "number"
    ? isUsableNumber(value)
    : typeof value === "object" &&
      value !== null &&
      typeof (value as QuantityRange).min === "number" &&
      typeof (value as QuantityRange).max === "number" &&
      isUsableNumber((value as QuantityRange).min) &&
      isUsableNumber((value as QuantityRange).max);

const normalizeRange = (value: FormattableQuantity): FormattableQuantity =>
  isRangeValue(value) && value.min > value.max ? { min: value.max, max: value.min } : value;

/**
 * Formats an amount for people: friendly unicode fractions ("⅔", "1 ½"), en-dash ranges
 * ("1–2"), and never float noise ("0.6666666666666666" → "⅔", "0.30000000000000004" → "0.3").
 * Missing, negative or non-finite input formats as "".
 */
export const formatQuantity = (
  value: FormattableQuantity | null | undefined,
  options: FormatQuantityOptions = {}
): string => {
  if (!isFormattable(value)) {
    return "";
  }

  return formatValue(normalizeRange(value), (options.style ?? "fraction") === "fraction");
};

/**
 * Formats an amount with its unit, pluralized to agree with the printed number: "1 cup",
 * "2 cups", "½ cup", "250 g", "1 ½ Tbsp", "3 cloves", "2 bottles". Units follow the same rules
 * as scaled ingredient lines: cups and spoons print fractions, grams and pounds print decimals.
 * A null unit prints the bare amount; a null amount prints "".
 */
export const formatIngredientQuantity = (
  qty: FormattableQuantity | null | undefined,
  unit: string | null | undefined,
  options: FormatIngredientQuantityOptions = {}
): string => {
  if (!isFormattable(qty)) {
    return "";
  }

  const value = normalizeRange(qty);
  const definition = getUnitDefinition(unit);
  const trimmedUnit = unit?.trim() ?? "";
  const isWholeItem = trimmedUnit.length === 0 || definition?.whole === true;
  const fractional = definition ? definition.fractional || definition.whole : true;
  const quantityText =
    isWholeItem && options.wholeItems === "range"
      ? formatWholeQuantity(value)
      : formatValue(value, fractional);

  if (trimmedUnit.length === 0) {
    return quantityText;
  }

  const label = formatUnitLabel(
    definition?.canonical ?? trimmedUnit,
    displayedValue(quantityText, value)
  );
  return `${quantityText} ${label}`;
};
