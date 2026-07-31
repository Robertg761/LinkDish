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
  canonical: string;
  singular: string;
  plural: string;
  compact?: string;
  fractional: boolean;
  whole: boolean;
};

const vulgarFractionValues: Record<string, number> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8
};

const vulgarFractionLabels: Record<number, string> = {
  1: "⅛",
  2: "¼",
  3: "⅜",
  4: "½",
  5: "⅝",
  6: "¾",
  7: "⅞"
};

const unitDefinitions: readonly UnitDefinition[] = [
  {
    aliases: ["tablespoons", "tablespoon", "tbsp.", "tbsp", "tbs."],
    canonical: "Tbsp",
    singular: "tablespoon",
    plural: "tablespoons",
    compact: "Tbsp",
    fractional: true,
    whole: false
  },
  {
    aliases: ["teaspoons", "teaspoon", "tsp.", "tsp"],
    canonical: "tsp",
    singular: "teaspoon",
    plural: "teaspoons",
    compact: "tsp",
    fractional: true,
    whole: false
  },
  {
    aliases: ["cups", "cup"],
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

const numberPattern = String.raw`(?:\d+(?:\.\d+)?(?:\s+(?:\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞]))?|\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞])`;
const leadingQuantityPattern = new RegExp(
  String.raw`^\s*(${numberPattern})(?:\s*(?:-|–|—|\bto\b)\s*(${numberPattern}))?(?=\s|$)`,
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

const parseNumberPhrase = (value: string): number | null => {
  const normalized = value.trim();
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

  for (const definition of unitDefinitions) {
    for (const alias of definition.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^${escaped}(?=\\s|$|,|\\])`, "i").exec(trimmed);

      if (match) {
        return {
          definition,
          rest: trimmed.slice(match[0].length).replace(/^\s+of\b/i, "").trim()
        };
      }
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
  if (Math.abs(value - Math.round(value)) < 0.001) {
    return String(Math.round(value));
  }

  if (value >= 10) {
    return String(Math.round(value));
  }

  return String(Math.round(value * 10) / 10).replace(/\.0$/, "");
};

const formatVulgarFraction = (value: number): string => {
  const whole = Math.floor(value);
  const eighths = Math.round((value - whole) * 8);

  if (eighths === 0) {
    return String(whole);
  }

  if (eighths === 8) {
    return String(whole + 1);
  }

  const fraction = vulgarFractionLabels[eighths] ?? "";
  return whole > 0 ? `${whole} ${fraction}` : fraction;
};

const isRange = (value: Exclude<ParsedQuantityValue, null>): value is { min: number; max: number } =>
  typeof value !== "number";

const formatMeasuredQuantity = (value: Exclude<ParsedQuantityValue, null>, unit: string | null): string => {
  const definition = unit ? unitAliasLookup.get(unit.toLowerCase()) : undefined;
  const formatter = definition?.fractional ? formatVulgarFraction : formatDecimal;

  if (isRange(value)) {
    return `${formatter(value.min)}–${formatter(value.max)}`;
  }

  return formatter(value);
};

const formatWholeQuantity = (value: Exclude<ParsedQuantityValue, null>): string => {
  const min = isRange(value) ? value.min : value;
  const max = isRange(value) ? value.max : value;

  if (Number.isInteger(min) && Number.isInteger(max)) {
    return min === max ? String(min) : `${min}–${max}`;
  }

  const roundedMin = Math.max(1, Math.floor(min));
  const roundedMax = Math.max(1, Math.ceil(max));
  return roundedMin === roundedMax ? String(roundedMin) : `${roundedMin}–${roundedMax}`;
};

const formatUnit = (unit: string, value: Exclude<ParsedQuantityValue, null>): string => {
  const definition = unitAliasLookup.get(unit.toLowerCase());

  if (!definition) {
    return unit;
  }

  if (definition.compact) {
    return definition.compact;
  }

  if (isRange(value)) {
    return value.max <= 1 ? definition.singular : definition.plural;
  }

  return value <= 1 ? definition.singular : definition.plural;
};

const shouldUseWholeRange = (parsed: ParsedIngredientQuantity): boolean => {
  if (parsed.unit == null) {
    return true;
  }

  const definition = unitAliasLookup.get(parsed.unit.toLowerCase());
  return definition?.whole ?? false;
};

/**
 * Parses a leading ingredient quantity, optional unit, optional bracketed
 * alternate quantity, and the remaining item text.
 *
 * Lines without a clear leading quantity return the original line as `item`
 * with `confident:false`, which lets scaling callers skip them safely.
 */
export const parseIngredientQuantity = (text: string): ParsedIngredientQuantity => {
  const parsedQuantity = parseQuantityValue(text);

  if (!parsedQuantity) {
    return unconfident(text);
  }

  const unit = parseUnit(parsedQuantity.rest);
  const alt = parseAltQuantity(unit?.rest ?? parsedQuantity.rest);
  const item = alt.rest.trim();

  if (!item) {
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
 */
export const scaleQuantity = (parsed: ParsedIngredientQuantity, factor: number): string => {
  if (!parsed.confident || parsed.qty == null || !Number.isFinite(factor) || factor <= 0) {
    return parsed.item;
  }

  const scaledQty = scaleValue(parsed.qty, factor);
  const quantityText = shouldUseWholeRange(parsed)
    ? formatWholeQuantity(scaledQty)
    : formatMeasuredQuantity(scaledQty, parsed.unit);
  const unitText = parsed.unit ? ` ${formatUnit(parsed.unit, scaledQty)}` : "";
  const altText =
    parsed.altQty != null && parsed.altUnit
      ? ` [${formatMeasuredQuantity(scaleValue(parsed.altQty, factor), parsed.altUnit)} ${parsed.altUnit}]`
      : "";

  return `${quantityText}${unitText}${altText} ${parsed.item}`.trim();
};
