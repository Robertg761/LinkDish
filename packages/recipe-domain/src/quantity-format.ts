/**
 * Public quantity formatting. formatQuantity (numbers only) lives in number-format.ts, so what
 * only prints numbers doesn't pull in the unit tables; formatIngredientQuantity adds units.
 */
import { formatUnitLabel } from "./format-internal.js";
import {
  displayedValue,
  formatValue,
  formatWholeQuantity,
  isFormattable,
  normalizeRange
} from "./number-format.js";
import { getUnitDefinition } from "./units.js";

import type { FormattableQuantity } from "./number-format.js";

export { formatQuantity } from "./number-format.js";
export type { FormatQuantityOptions, FormattableQuantity, QuantityRange } from "./number-format.js";

export type FormatIngredientQuantityOptions = {
  /**
   * How to print amounts of whole items (no unit, or cans/cloves/pinches). "exact" (default)
   * keeps friendly fractions ("1 ½ cans"); "range" rounds to whole-number ranges like scaling
   * does ("1–2 cans").
   */
  wholeItems?: "exact" | "range" | undefined;
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
