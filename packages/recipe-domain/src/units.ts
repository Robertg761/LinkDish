/**
 * The unit vocabulary shared by the ingredient parser, the scaler, the unit converter and
 * shopping aggregation. Canonical names ("Tbsp", "tsp", "cup", "g", "ml"...) are part of the
 * public contract: they are stored on shopping items and compared by the apps.
 */

export type UnitKind = "volume" | "mass" | "count";
export type UnitSystem = "us" | "metric" | "neutral";

export type UnitDefinition = {
  canonical: string;
  /** Aliases matched case-insensitively. A trailing "." is optional for every alias. */
  aliases: readonly string[];
  /**
   * Aliases that only match with their exact casing. Used for single letters where case is the
   * only thing separating two units ("T" tablespoon vs "t" teaspoon).
   */
  caseSensitiveAliases?: readonly string[];
  singular: string;
  plural: string;
  /** Label printed regardless of amount ("Tbsp", "g"). Units without one pluralize. */
  compact?: string;
  /** Rendered with vulgar fractions (cups, spoons) rather than decimals (grams, pounds). */
  fractional: boolean;
  /** Whole-item units rounded to integer ranges when scaled (cans, cloves, pinches). */
  whole: boolean;
  kind: UnitKind;
  system: UnitSystem;
  /** Millilitres (volume) or grams (mass) in one unit. */
  base?: number;
  /**
   * Packaging units. A parenthetical right after one of them is the package size, which does
   * not scale ("2 cans (15 oz) beans" is two 15 oz cans), not an alternate amount.
   */
  container?: boolean;
  /** May be written glued to the number with no space ("200g", "250ml", "2cups"). */
  attachable?: boolean;
};

export const ML_PER_TSP = 4.928_921_593_75;
export const ML_PER_TBSP = ML_PER_TSP * 3;
export const ML_PER_FL_OZ = ML_PER_TBSP * 2;
export const ML_PER_CUP = ML_PER_FL_OZ * 8;
export const ML_PER_PINT = ML_PER_CUP * 2;
export const ML_PER_QUART = ML_PER_CUP * 4;
export const ML_PER_GALLON = ML_PER_QUART * 4;
export const G_PER_OZ = 28.349_523_125;
export const G_PER_LB = G_PER_OZ * 16;

const countUnit = (
  canonical: string,
  plural: string,
  aliases: readonly string[],
  options: { container?: boolean; fractional?: boolean } = {}
): UnitDefinition => ({
  canonical,
  aliases,
  singular: canonical,
  plural,
  fractional: options.fractional ?? false,
  whole: !(options.fractional ?? false),
  kind: "count",
  system: "neutral",
  ...(options.container ? { container: true } : {})
});

/**
 * Order matters only for display lookups by canonical name; alias matching is exact, so longer
 * and shorter aliases never shadow each other.
 */
export const UNIT_DEFINITIONS: readonly UnitDefinition[] = [
  {
    canonical: "Tbsp",
    aliases: [
      "tablespoonfuls",
      "tablespoonful",
      "tablespoons",
      "tablespoon",
      "tbsps",
      "tbsp",
      "tbs",
      "tbl",
      "tbls",
      "tb"
    ],
    caseSensitiveAliases: ["T"],
    singular: "tablespoon",
    plural: "tablespoons",
    compact: "Tbsp",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_TBSP,
    attachable: true
  },
  {
    canonical: "tsp",
    aliases: ["teaspoonfuls", "teaspoonful", "teaspoons", "teaspoon", "tsps", "tsp", "tspn"],
    caseSensitiveAliases: ["t"],
    singular: "teaspoon",
    plural: "teaspoons",
    compact: "tsp",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_TSP,
    attachable: true
  },
  {
    canonical: "cup",
    aliases: ["cupfuls", "cupful", "cups", "cup", "c"],
    singular: "cup",
    plural: "cups",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_CUP,
    attachable: true
  },
  {
    canonical: "fl oz",
    aliases: ["fluid ounces", "fluid ounce", "fl oz", "fl. oz", "floz", "fl ozs"],
    singular: "fluid ounce",
    plural: "fluid ounces",
    compact: "fl oz",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_FL_OZ
  },
  {
    canonical: "pt",
    aliases: ["pints", "pint", "pts", "pt"],
    singular: "pint",
    plural: "pints",
    compact: "pt",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_PINT
  },
  {
    canonical: "qt",
    aliases: ["quarts", "quart", "qts", "qt"],
    singular: "quart",
    plural: "quarts",
    compact: "qt",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_QUART
  },
  {
    canonical: "gal",
    aliases: ["gallons", "gallon", "gals", "gal"],
    singular: "gallon",
    plural: "gallons",
    compact: "gal",
    fractional: true,
    whole: false,
    kind: "volume",
    system: "us",
    base: ML_PER_GALLON
  },
  {
    canonical: "ml",
    aliases: ["milliliters", "milliliter", "millilitres", "millilitre", "mls", "ml", "mL"],
    singular: "milliliter",
    plural: "milliliters",
    compact: "ml",
    fractional: false,
    whole: false,
    kind: "volume",
    system: "metric",
    base: 1,
    attachable: true
  },
  {
    canonical: "cl",
    aliases: ["centiliters", "centiliter", "centilitres", "centilitre", "cl"],
    singular: "centiliter",
    plural: "centiliters",
    compact: "cl",
    fractional: false,
    whole: false,
    kind: "volume",
    system: "metric",
    base: 10,
    attachable: true
  },
  {
    canonical: "dl",
    aliases: ["deciliters", "deciliter", "decilitres", "decilitre", "dl"],
    singular: "deciliter",
    plural: "deciliters",
    compact: "dl",
    fractional: false,
    whole: false,
    kind: "volume",
    system: "metric",
    base: 100,
    attachable: true
  },
  {
    canonical: "l",
    aliases: ["liters", "liter", "litres", "litre", "ltrs", "ltr", "l"],
    singular: "liter",
    plural: "liters",
    compact: "l",
    fractional: false,
    whole: false,
    kind: "volume",
    system: "metric",
    base: 1000,
    attachable: true
  },
  {
    canonical: "oz",
    aliases: ["ounces", "ounce", "ozs", "oz"],
    singular: "ounce",
    plural: "ounces",
    compact: "oz",
    fractional: false,
    whole: false,
    kind: "mass",
    system: "us",
    base: G_PER_OZ,
    attachable: true
  },
  {
    canonical: "lb",
    aliases: ["pounds", "pound", "lbs", "lb"],
    singular: "pound",
    plural: "pounds",
    compact: "lb",
    fractional: false,
    whole: false,
    kind: "mass",
    system: "us",
    base: G_PER_LB,
    attachable: true
  },
  {
    canonical: "mg",
    aliases: ["milligrams", "milligram", "milligrammes", "milligramme", "mg"],
    singular: "milligram",
    plural: "milligrams",
    compact: "mg",
    fractional: false,
    whole: false,
    kind: "mass",
    system: "metric",
    base: 0.001,
    attachable: true
  },
  {
    canonical: "g",
    aliases: ["grams", "gram", "grammes", "gramme", "gr", "grs", "gms", "gm", "g"],
    singular: "gram",
    plural: "grams",
    compact: "g",
    fractional: false,
    whole: false,
    kind: "mass",
    system: "metric",
    base: 1,
    attachable: true
  },
  {
    canonical: "kg",
    aliases: ["kilograms", "kilogram", "kilogrammes", "kilogramme", "kilos", "kilo", "kgs", "kg"],
    singular: "kilogram",
    plural: "kilograms",
    compact: "kg",
    fractional: false,
    whole: false,
    kind: "mass",
    system: "metric",
    base: 1000,
    attachable: true
  },
  countUnit("can", "cans", ["cans", "can"], { container: true }),
  countUnit("tin", "tins", ["tins", "tin"], { container: true }),
  countUnit("jar", "jars", ["jars", "jar"], { container: true }),
  countUnit("package", "packages", ["packages", "package", "pkgs", "pkg", "pkts", "pkt"], {
    container: true
  }),
  countUnit("packet", "packets", ["packets", "packet"], { container: true }),
  countUnit("envelope", "envelopes", ["envelopes", "envelope"], { container: true }),
  countUnit("sachet", "sachets", ["sachets", "sachet"], { container: true }),
  countUnit("bag", "bags", ["bags", "bag"], { container: true }),
  countUnit("box", "boxes", ["boxes", "box"], { container: true }),
  countUnit("bottle", "bottles", ["bottles", "bottle"], { container: true }),
  countUnit("carton", "cartons", ["cartons", "carton"], { container: true }),
  countUnit("container", "containers", ["containers", "container"], { container: true }),
  countUnit("tub", "tubs", ["tubs", "tub"], { container: true }),
  countUnit("block", "blocks", ["blocks", "block"], { container: true }),
  countUnit("clove", "cloves", ["cloves", "clove"]),
  countUnit("handful", "handfuls", ["handfuls", "handful"]),
  countUnit("pinch", "pinches", ["pinches", "pinch"]),
  countUnit("slice", "slices", ["slices", "slice"]),
  countUnit("sprig", "sprigs", ["sprigs", "sprig"]),
  countUnit("stalk", "stalks", ["stalks", "stalk"]),
  countUnit("head", "heads", ["heads", "head"]),
  countUnit("piece", "pieces", ["pieces", "piece", "pcs", "pc"]),
  countUnit("sheet", "sheets", ["sheets", "sheet"]),
  countUnit("strip", "strips", ["strips", "strip"]),
  countUnit("cube", "cubes", ["cubes", "cube"]),
  countUnit("ear", "ears", ["ears", "ear"]),
  countUnit("drop", "drops", ["drops", "drop"]),
  countUnit("stick", "sticks", ["sticks", "stick"], { fractional: true }),
  countUnit("dash", "dashes", ["dashes", "dash"], { fractional: true }),
  countUnit("bunch", "bunches", ["bunches", "bunch"], { fractional: true }),
  countUnit("splash", "splashes", ["splashes", "splash"], { fractional: true })
];

const TRAILING_DOT_PATTERN = /\.$/u;

const definitionsByCanonical = new Map(
  UNIT_DEFINITIONS.map((definition) => [definition.canonical.toLowerCase(), definition] as const)
);

/** Lowercased alias (and dot-less alias) → definition. */
export const UNIT_ALIAS_LOOKUP: ReadonlyMap<string, UnitDefinition> = new Map(
  UNIT_DEFINITIONS.flatMap((definition) =>
    [...definition.aliases, definition.canonical].map(
      (alias) => [alias.toLowerCase(), definition] as const
    )
  )
);

/** Exact-case aliases ("T", "t"), checked before the case-insensitive table. */
export const UNIT_CASE_SENSITIVE_LOOKUP: ReadonlyMap<string, UnitDefinition> = new Map(
  UNIT_DEFINITIONS.flatMap((definition) =>
    (definition.caseSensitiveAliases ?? []).map((alias) => [alias, definition] as const)
  )
);

/**
 * Looks a unit up by canonical name or any alias ("Tbsp", "tablespoons", "g", "grams").
 * Case-sensitive single letters resolve first so "T" stays a tablespoon.
 */
export const getUnitDefinition = (unit: string | null | undefined): UnitDefinition | undefined => {
  if (!unit) {
    return undefined;
  }

  const trimmed = unit.trim();
  return (
    UNIT_CASE_SENSITIVE_LOOKUP.get(trimmed) ??
    definitionsByCanonical.get(trimmed.toLowerCase()) ??
    UNIT_ALIAS_LOOKUP.get(trimmed.toLowerCase().replace(TRAILING_DOT_PATTERN, ""))
  );
};

/** Canonical unit name for any alias, or null when the unit is unknown. */
export const canonicalUnit = (unit: string | null | undefined): string | null =>
  getUnitDefinition(unit)?.canonical ?? null;

/**
 * Volume and mass aliases, longest first, for patterns that look for measurements inside free
 * text (notes inside an ingredient line). Count units are deliberately excluded ("cut into 4
 * pieces" is not an amount to scale), and so are the one-letter aliases that read as words or
 * initials in prose ("c", "t", "T"); "g" and "l" stay because "(50g)" is how weights are written.
 */
export const MEASUREMENT_UNIT_ALIASES: readonly string[] = [
  ...new Set(
    UNIT_DEFINITIONS.filter((definition) => definition.kind !== "count")
      .flatMap((definition) => definition.aliases)
      .map((alias) => alias.toLowerCase())
      .filter((alias) => alias.length > 1 || alias === "g" || alias === "l")
  )
].sort((left, right) => right.length - left.length);
