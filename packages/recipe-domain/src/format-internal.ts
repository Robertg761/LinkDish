/**
 * Number and unit rendering shared by the scaler, the converter and the shopping formatter.
 * Internal: index.ts does not re-export this module; the public surface is quantity-format.ts.
 * The unit-free number helpers live in number-format.ts and are re-exported here.
 */
import { inflectNoun } from "./inflection.js";
import { formatValue } from "./number-format.js";
import { getUnitDefinition } from "./units.js";

import type { QuantityValue } from "./number-format.js";

export {
  displayedValue,
  FRACTION_CANDIDATES,
  formatDecimal,
  formatValue,
  formatVulgarFraction,
  formatWholeQuantity,
  isRangeValue,
  maxOfValue,
  scaleValue,
  tryVulgarFraction
} from "./number-format.js";
export type { QuantityValue } from "./number-format.js";

export const formatMeasuredQuantity = (value: QuantityValue, unit: string | null): string =>
  formatValue(value, getUnitDefinition(unit)?.fractional ?? false);

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
