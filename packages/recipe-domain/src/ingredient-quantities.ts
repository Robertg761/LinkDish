import {
  displayedValue,
  formatMeasuredQuantity,
  formatUnitLabel,
  formatWholeQuantity,
  maxOfValue,
  scaleValue
} from "./format-internal.js";
import { inflectIngredientPhrase } from "./inflection.js";
import {
  NUMBER_PHRASE_PATTERN,
  normalizeFractionSlashes,
  parseNumberPhrase,
  VULGAR_FRACTION_CHARACTERS,
  WORD_NUMBER_PATTERN
} from "./number-phrases.js";
import {
  getUnitDefinition,
  MEASUREMENT_UNIT_ALIASES,
  UNIT_ALIAS_LOOKUP,
  UNIT_CASE_SENSITIVE_LOOKUP
} from "./units.js";

import type { UnitDefinition } from "./units.js";

export type ParsedQuantityValue = number | { min: number; max: number } | null;

type QuantityAmount = Exclude<ParsedQuantityValue, null>;

/**
 * The size of one package, written between the count and the unit ("1 (15-ounce) can"), after
 * a packaging unit ("2 cans (14 oz)"), glued to the count ("2 14.5-oz cans") or as a multiplier
 * ("2 x 400g tins"). It describes each package, so it never scales.
 */
export type IngredientPackageSize = {
  /** The size exactly as written, without delimiters: "15-ounce", "14 oz", "400g". */
  text: string;
  qty: QuantityAmount;
  /** Canonical unit of the size ("oz", "g"). */
  unit: string;
  style: "paren" | "bracket" | "bare" | "times";
  /** True for "1 can (15 oz)", false for "1 (15 oz) can". */
  afterUnit: boolean;
};

export type ParsedIngredientQuantity = {
  qty: ParsedQuantityValue;
  unit: string | null;
  altQty: ParsedQuantityValue;
  altUnit: string | null;
  item: string;
  confident: boolean;
  /**
   * Set only when the alternate amount was written in parentheses ("3 cups (360g) flour"). The
   * default, absent, means square brackets ("2 cups [280 g] flour").
   */
  altStyle?: "paren" | undefined;
  /** Set only for lines that carry a package size; see `IngredientPackageSize`. */
  packageSize?: IngredientPackageSize | undefined;
  /** Set only for compound amounts: the "2 tablespoons" in "1 cup plus 2 tablespoons flour". */
  addition?: IngredientAddition | undefined;
};

/** A second amount added to the first ("1 cup plus 2 tablespoons"); same kind of unit. */
export type IngredientAddition = {
  qty: number;
  /** Canonical unit. */
  unit: string;
  joiner: "plus" | "+" | "and";
};

export type FormatParsedIngredientOptions = {
  /** Multiplier applied to the amount, the alternate amount and amounts inside the item text. */
  factor?: number | undefined;
  /**
   * Rewrites volume/mass amounts found inside the item text ("…or ¼ cup (50g) oil"). Receives
   * the amount and its unit, returns the replacement text or null to keep the original. When
   * omitted, embedded amounts are scaled by `factor`.
   */
  transformEmbeddedAmount?:
    | ((
        value: QuantityAmount,
        unit: UnitDefinition,
        context: EmbeddedAmountContext
      ) => string | null)
    | undefined;
  /**
   * Overrides how a measured amount (the main amount or the alternate) is printed; return null
   * for the default. Count units and unitless amounts always use whole-item rounding.
   */
  formatAmount?: ((value: QuantityAmount, unit: UnitDefinition) => string | null) | undefined;
  /**
   * The count the item text was written for, when `parsed.qty` has already been rescaled by the
   * caller. Defaults to the parsed amount; used to re-inflect the head noun ("egg" → "eggs").
   */
  writtenCount?: number | undefined;
};

/** Scale factors outside this range produce unusable text, so they are clamped. */
const MIN_SCALE_FACTOR = 0.05;
const MAX_SCALE_FACTOR = 50;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NUMBER_OR_WORD = `(?:${NUMBER_PHRASE_PATTERN}|${WORD_NUMBER_PATTERN})`;
const RANGE_SEPARATOR = String.raw`\s*(?:-|–|—|\bto\b|\bor\b)\s*`;

/**
 * A leading amount: a number phrase and an optional range ("2-3", "1 to 2", "2 or 3"). The
 * lookahead accepts a letter so a glued unit ("200g") can be checked by the caller.
 */
const LEADING_QUANTITY_PATTERN = new RegExp(
  String.raw`^\s*(${NUMBER_OR_WORD})(?:${RANGE_SEPARATOR}(${NUMBER_OR_WORD}))?(?=\s|$|[A-Za-z([])`,
  "i"
);
/** First one or two words of a unit ("tbsp.", "fl oz", "fluid ounces"). */
const UNIT_TOKEN_PATTERN = /^([A-Za-z]+)(\.)?(?:(\s+)([A-Za-z]+)(\.)?)?/;
/** What may follow a unit: whitespace, punctuation that closes or separates, or the end. */
const UNIT_BOUNDARY_PATTERN = /^(?:$|[\s,;:)\]([/*])/;
const LEADING_OF_PATTERN = /^\s*of\b\s*/i;
/** "plus", "+" or "and" joining a second amount: "1 cup plus 2 tablespoons". */
const ADDITION_JOINER_PATTERN = new RegExp(
  `^(plus|\\+|and)\\s*(?=[\\d.${VULGAR_FRACTION_CHARACTERS}])`,
  "i"
);
const LEADING_GROUP_PATTERN = /^([([])([^()[\]]*)([)\]])\s*/;
const MULTIPLIER_PATTERN = /^[x×]\s*(?=[\d.])/i;
/** "15-ounce" → "15 ounce", length-preserving so the original spelling can be sliced back out. */
const NUMBER_HYPHEN_UNIT_PATTERN = /(\d)-(?=[A-Za-z])/g;
const RANGE_CONTINUATION_PATTERN = new RegExp(
  `^${RANGE_SEPARATOR}(?=[\\d.${VULGAR_FRACTION_CHARACTERS}])`,
  "i"
);
const EMBEDDED_UNIT_SOURCE = MEASUREMENT_UNIT_ALIASES.map(escapeRegExp).join("|");
/**
 * A volume or mass amount inside free text: "¼ cup", "(50g)", "1 1/2 to 2 teaspoons". The
 * lookbehind keeps it from starting mid-token and the lookahead from ending inside a word, so
 * "15-ounce" (an adjective) and "2 cupcakes" never match.
 */
const EMBEDDED_AMOUNT_PATTERN = new RegExp(
  String.raw`(?<![\w./-])(${NUMBER_PHRASE_PATTERN})(?:\s*(?:-|–|—|\bto\b)\s*(${NUMBER_PHRASE_PATTERN}))?(\s?)(${EMBEDDED_UNIT_SOURCE})(\.?)(?![A-Za-z0-9-])`,
  "gi"
);
/** Words that make an embedded amount describe a package or a piece rather than an amount. */
const DESCRIPTOR_BEFORE_AMOUNT_PATTERN = /\b(?:a|an|per|each|every|into)\s+$/i;
/** "…¼ cup (" — an opening bracket right after a measurement introduces its alternate. */
const ALTERNATE_AFTER_MEASUREMENT_PATTERN = new RegExp(
  String.raw`(?:${EMBEDDED_UNIT_SOURCE})\.?\s*[([]\s*$`,
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

const clampFactor = (factor: number): number =>
  Number.isFinite(factor) && factor > 0
    ? Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, factor))
    : 1;

const toRange = (first: number, second: number | null): QuantityAmount =>
  second == null ? first : { min: Math.min(first, second), max: Math.max(first, second) };

const parseQuantityValue = (
  text: string
): { value: QuantityAmount; rest: string; glued: boolean } | null => {
  const match = LEADING_QUANTITY_PATTERN.exec(text);

  if (!match) {
    return null;
  }

  const first = parseNumberPhrase(match[1] ?? "");
  const second = match[2] ? parseNumberPhrase(match[2]) : null;

  if (first == null || (match[2] && second == null)) {
    return null;
  }

  const rest = text.slice(match[0].length);

  return {
    value: toRange(first, second),
    rest: rest.trim(),
    glued: rest.length > 0 && rest.trimStart().length === rest.length && rest[0] !== "("
  };
};

const lookupUnitToken = (token: string): UnitDefinition | undefined =>
  UNIT_CASE_SENSITIVE_LOOKUP.get(token) ?? UNIT_ALIAS_LOOKUP.get(token.toLowerCase());

/**
 * Reads a unit at the start of `text` with two map lookups (two-word aliases such as "fl oz"
 * first, then one word). Every pattern it uses is compiled at module load: this runs for every
 * ingredient line on every scale change.
 */
const parseUnit = (text: string): { definition: UnitDefinition; rest: string } | null => {
  const trimmed = text.trimStart();
  const match = UNIT_TOKEN_PATTERN.exec(trimmed);

  if (!match) {
    return null;
  }

  const [, firstWord = "", firstDot = "", gap = "", secondWord = "", secondDot = ""] = match;
  const candidates: Array<{ definition: UnitDefinition | undefined; length: number }> = [];

  if (secondWord) {
    candidates.push({
      definition: UNIT_ALIAS_LOOKUP.get(`${firstWord} ${secondWord}`.toLowerCase()),
      length: firstWord.length + firstDot.length + gap.length + secondWord.length + secondDot.length
    });
  }

  candidates.push({
    definition: lookupUnitToken(firstWord),
    length: firstWord.length + firstDot.length
  });

  for (const candidate of candidates) {
    if (!candidate.definition) {
      continue;
    }

    const after = trimmed.slice(candidate.length);

    if (!UNIT_BOUNDARY_PATTERN.test(after)) {
      continue;
    }

    return {
      definition: candidate.definition,
      rest: after.replace(LEADING_OF_PATTERN, "").trim()
    };
  }

  return null;
};

const parseAltQuantity = (
  text: string
): { qty: QuantityAmount; unit: string; style: "paren" | "bracket"; rest: string } | null => {
  const group = LEADING_GROUP_PATTERN.exec(text);

  if (!group || (group[1] === "(" && group[3] !== ")") || (group[1] === "[" && group[3] !== "]")) {
    return null;
  }

  const amount = parseAmount(group[2] ?? "");

  if (!amount?.unit || amount.rest.length > 0) {
    return null;
  }

  return {
    qty: amount.value,
    unit: amount.unit.canonical,
    style: group[1] === "(" ? "paren" : "bracket",
    rest: text.slice(group[0].length).replace(LEADING_OF_PATTERN, "").trim()
  };
};

/**
 * Parses "<amount> <unit>" with an optional unit on each end of a range ("113g to 152g",
 * "1 cup to 1 1/4 cups"). A number glued to text must be glued to a unit that allows it.
 */
const parseAmount = (
  text: string
): { value: QuantityAmount; unit: UnitDefinition | null; rest: string } | null => {
  const quantity = parseQuantityValue(text);

  if (!quantity) {
    return null;
  }

  const unit = parseUnit(quantity.rest);

  if (quantity.glued && !unit?.definition.attachable) {
    return null;
  }

  if (!unit) {
    return { value: quantity.value, unit: null, rest: quantity.rest };
  }

  if (typeof quantity.value === "number") {
    const continuation = RANGE_CONTINUATION_PATTERN.exec(unit.rest);
    const upper = continuation ? parseQuantityValue(unit.rest.slice(continuation[0].length)) : null;
    const upperUnit = upper ? parseUnit(upper.rest) : null;

    if (
      upper &&
      typeof upper.value === "number" &&
      upperUnit?.definition === unit.definition &&
      (!upper.glued || upperUnit.definition.attachable)
    ) {
      return {
        value: toRange(quantity.value, upper.value),
        unit: unit.definition,
        rest: upperUnit.rest
      };
    }
  }

  return { value: quantity.value, unit: unit.definition, rest: unit.rest };
};

const isMeasurement = (definition: UnitDefinition | null | undefined): boolean =>
  definition != null && definition.kind !== "count";

/** Reads a package size such as "15-ounce", "14.5 oz" or "400g"; the whole text must be used. */
const parseSizeText = (text: string): { qty: QuantityAmount; unit: string } | null => {
  const amount = parseAmount(text.replace(NUMBER_HYPHEN_UNIT_PATTERN, "$1 "));

  return amount && isMeasurement(amount.unit) && amount.rest.length === 0 && amount.unit
    ? { qty: amount.value, unit: amount.unit.canonical }
    : null;
};

/** A package size written right after the count: "(15-ounce)", "15-oz", "28 oz", "x 400g". */
const parseLeadingPackageSize = (
  rest: string
): { packageSize: IngredientPackageSize; rest: string } | null => {
  const group = LEADING_GROUP_PATTERN.exec(rest);

  if (group) {
    const size = parseSizeText(group[2]?.trim() ?? "");

    return size
      ? {
          packageSize: {
            text: group[2]?.trim() ?? "",
            ...size,
            style: group[1] === "(" ? "paren" : "bracket",
            afterUnit: false
          },
          rest: rest.slice(group[0].length).trim()
        }
      : null;
  }

  const multiplier = MULTIPLIER_PATTERN.exec(rest);
  const candidate = multiplier ? rest.slice(multiplier[0].length) : rest;
  const amount = parseAmount(candidate.replace(NUMBER_HYPHEN_UNIT_PATTERN, "$1 "));

  // Keep the size exactly as written ("14.5-oz"): the hyphen normalization preserves length, so
  // the unparsed remainder is a suffix of the original text.
  if (!amount?.unit || !isMeasurement(amount.unit) || !candidate.endsWith(amount.rest)) {
    return null;
  }

  const rawText = candidate.slice(0, candidate.length - amount.rest.length).trim();

  if (rawText.length === 0) {
    return null;
  }

  return {
    packageSize: {
      text: rawText,
      qty: amount.value,
      unit: amount.unit.canonical,
      style: multiplier ? "times" : "bare",
      afterUnit: false
    },
    rest: amount.rest
  };
};

const trimItem = (text: string): string => text.replace(LEADING_OF_PATTERN, "").trim();

/**
 * Parses a leading ingredient quantity, optional package size, optional unit, optional
 * alternate quantity in brackets or parentheses, and the remaining item text.
 *
 * Lines without a clear leading quantity return the original line as `item` with
 * `confident:false`, which lets scaling callers skip them safely. A line that is nothing but an
 * amount ("2 cups") still parses confidently as long as it carries a unit, so it scales with the
 * rest of the recipe. A zero amount is treated as unconfident: there is nothing meaningful to
 * scale.
 */
export const parseIngredientQuantity = (text: string): ParsedIngredientQuantity => {
  const source = normalizeFractionSlashes(text);
  const quantity = parseQuantityValue(source);

  if (!quantity || maxOfValue(quantity.value) <= 0) {
    return unconfident(text);
  }

  let rest = quantity.rest;
  let packageSize: IngredientPackageSize | undefined;
  let unit: UnitDefinition | null = null;
  let value = quantity.value;

  if (quantity.glued) {
    const amount = parseAmount(source);

    if (!amount?.unit) {
      return unconfident(text);
    }

    value = amount.value;
    unit = amount.unit;
    rest = amount.rest;
  } else {
    const leadingSize = parseLeadingPackageSize(rest);

    if (leadingSize) {
      packageSize = leadingSize.packageSize;
      rest = leadingSize.rest;
    }

    const amount = packageSize ? null : parseAmount(source);
    const parsedUnit = amount ? null : parseUnit(rest);

    if (amount?.unit) {
      value = amount.value;
      unit = amount.unit;
      rest = amount.rest;
    } else if (parsedUnit) {
      unit = parsedUnit.definition;
      rest = parsedUnit.rest;
    }
  }

  let addition: IngredientAddition | undefined;
  const joiner = unit && unit.kind !== "count" ? ADDITION_JOINER_PATTERN.exec(rest) : null;

  if (unit && joiner && typeof value === "number") {
    // "1 cup plus 2 tablespoons": a second amount of the same kind that adds to the first.
    const extra = parseAmount(rest.slice(joiner[0].length));

    if (extra?.unit && extra.unit.kind === unit.kind && typeof extra.value === "number") {
      const word = (joiner[1] ?? "").toLowerCase();
      addition = {
        qty: extra.value,
        unit: extra.unit.canonical,
        joiner: word === "+" ? "+" : word === "and" ? "and" : "plus"
      };
      rest = extra.rest;
    }
  }

  let altQty: ParsedQuantityValue = null;
  let altUnit: string | null = null;
  let altStyle: "paren" | "bracket" | undefined;

  if (unit?.container && !packageSize) {
    const group = LEADING_GROUP_PATTERN.exec(rest);
    const size = group ? parseSizeText(group[2]?.trim() ?? "") : null;

    if (group && size) {
      packageSize = {
        text: group[2]?.trim() ?? "",
        ...size,
        style: group[1] === "(" ? "paren" : "bracket",
        afterUnit: true
      };
      rest = trimItem(rest.slice(group[0].length));
    }
  } else if (unit || !packageSize) {
    const alt = parseAltQuantity(rest);

    // A parenthetical after a bare count ("2 (about 1 lb) chicken breasts") is a size note, not
    // an alternate for the count; only measured lines get parenthetical alternates.
    if (alt && (unit != null || alt.style === "bracket")) {
      altQty = alt.qty;
      altUnit = alt.unit;
      altStyle = alt.style;
      rest = alt.rest;
    }
  }

  const item = rest.trim();

  if (!item && !unit) {
    return unconfident(text);
  }

  return {
    qty: value,
    unit: unit?.canonical ?? null,
    altQty,
    altUnit,
    item,
    confident: true,
    ...(altStyle === "paren" ? { altStyle } : {}),
    ...(packageSize ? { packageSize } : {}),
    ...(addition ? { addition } : {})
  };
};

const renderPackageSize = (packageSize: IngredientPackageSize): string => {
  switch (packageSize.style) {
    case "paren":
      return `(${packageSize.text})`;
    case "bracket":
      return `[${packageSize.text}]`;
    case "times":
      return `x ${packageSize.text}`;
    case "bare":
      return packageSize.text;
  }
};

export type EmbeddedAmountContext = {
  /**
   * The amount sits in brackets right after another measurement ("¼ cup (50g) oil"), so it is
   * that measurement's alternate rather than an amount of its own.
   */
  isAlternate: boolean;
};

/**
 * Rewrites every volume or mass amount inside free text. Amounts that describe a package or a
 * piece ("a 1 lb box", "per 8 oz serving") are left alone.
 */
export const transformEmbeddedAmounts = (
  text: string,
  transform: (
    value: QuantityAmount,
    unit: UnitDefinition,
    context: EmbeddedAmountContext
  ) => string | null
): string =>
  text.replace(
    EMBEDDED_AMOUNT_PATTERN,
    (
      match: string,
      firstText: string,
      secondText: string | undefined,
      _space: string,
      unitText: string,
      _dot: string,
      offset: number,
      source: string
    ) => {
      if (DESCRIPTOR_BEFORE_AMOUNT_PATTERN.test(source.slice(Math.max(0, offset - 8), offset))) {
        return match;
      }

      const definition = getUnitDefinition(unitText);
      const first = parseNumberPhrase(firstText);
      const second = secondText ? parseNumberPhrase(secondText) : null;

      if (!definition || first == null || (secondText && second == null) || first <= 0) {
        return match;
      }

      const before = source.slice(Math.max(0, offset - 24), offset);

      return (
        transform(toRange(first, second), definition, {
          isAlternate: ALTERNATE_AFTER_MEASUREMENT_PATTERN.test(before)
        }) ?? match
      );
    }
  );

/** Text for an amount of a unit, with the unit label agreeing with the rendered number. */
export const formatAmountWithUnit = (value: QuantityAmount, unit: string): string => {
  const quantityText = formatMeasuredQuantity(value, unit);
  return `${quantityText} ${formatUnitLabel(unit, displayedValue(quantityText, value))}`;
};

/**
 * Renders a parsed ingredient line, optionally multiplied by `factor`.
 *
 * Cup and spoon measurements use vulgar fractions; whole foods use rounded ranges so scaling
 * never prints 1.33 eggs. The package size stays as written, the alternate amount keeps its
 * brackets or parentheses, the head noun of a unitless line agrees with the new count
 * ("1 large egg" → "2 large eggs") and volume/mass amounts inside the item text scale too
 * ("…or ¼ cup (50g) oil"). Unconfident lines come back verbatim.
 */
export const formatParsedIngredient = (
  parsed: ParsedIngredientQuantity,
  options: FormatParsedIngredientOptions = {}
): string => {
  if (!parsed.confident || parsed.qty == null) {
    return parsed.item;
  }

  const factor = options.factor ?? 1;
  const definition = getUnitDefinition(parsed.unit);
  const scaledQty = scaleValue(parsed.qty, factor);
  const measuredText = (value: QuantityAmount, unitDefinition: UnitDefinition | undefined) =>
    (unitDefinition && options.formatAmount?.(value, unitDefinition)) ??
    formatMeasuredQuantity(value, unitDefinition?.canonical ?? null);
  const quantityText =
    parsed.unit == null || definition?.whole
      ? formatWholeQuantity(scaledQty)
      : measuredText(scaledQty, definition);
  const shownValue = displayedValue(quantityText, scaledQty);
  const parts = [quantityText];

  if (parsed.packageSize && !parsed.packageSize.afterUnit) {
    parts.push(renderPackageSize(parsed.packageSize));
  }

  if (parsed.unit) {
    parts.push(formatUnitLabel(parsed.unit, shownValue));
  }

  if (parsed.packageSize?.afterUnit) {
    parts.push(renderPackageSize(parsed.packageSize));
  }

  if (parsed.addition) {
    const additionValue = parsed.addition.qty * factor;
    const additionText = measuredText(additionValue, getUnitDefinition(parsed.addition.unit));
    parts.push(
      parsed.addition.joiner,
      `${additionText} ${formatUnitLabel(parsed.addition.unit, displayedValue(additionText, additionValue))}`
    );
  }

  if (parsed.altQty != null && parsed.altUnit) {
    const altValue = scaleValue(parsed.altQty, factor);
    const altQuantityText = measuredText(altValue, getUnitDefinition(parsed.altUnit));
    const altText = `${altQuantityText} ${formatUnitLabel(
      parsed.altUnit,
      displayedValue(altQuantityText, altValue)
    )}`;
    parts.push(parsed.altStyle === "paren" ? `(${altText})` : `[${altText}]`);
  }

  let item = parsed.item;

  if (item && parsed.unit == null) {
    item = inflectIngredientPhrase(
      item,
      options.writtenCount ?? maxOfValue(parsed.qty),
      shownValue
    );
  }

  // Amounts in a packaged line's notes describe the package ("1 package yeast (2 1/4 tsp)"),
  // so they never scale or convert.
  const rewritesEmbedded = item.length > 0 && !definition?.container;

  if (rewritesEmbedded && options.transformEmbeddedAmount) {
    item = transformEmbeddedAmounts(item, options.transformEmbeddedAmount);
  } else if (rewritesEmbedded && factor !== 1) {
    item = transformEmbeddedAmounts(item, (value, unit) =>
      formatAmountWithUnit(scaleValue(value, factor), unit.canonical)
    );
  }

  if (item) {
    parts.push(item);
  }

  return parts.join(" ").trim();
};

/**
 * Renders a scaled ingredient line from a parsed quantity.
 *
 * Factors are clamped to a usable range, and a nonsensical factor falls back to 1 so the line
 * keeps its amount rather than losing it. See `formatParsedIngredient` for the rendering rules.
 */
export const scaleQuantity = (parsed: ParsedIngredientQuantity, factor: number): string =>
  formatParsedIngredient(parsed, { factor: clampFactor(factor) });
