/**
 * Shopping-list aggregation shared by web and mobile: turning ingredient lines into shopping
 * inputs, keying items so "2 large eggs, beaten" and "1 egg" land on one line, adding amounts
 * without ever losing one (numbers + ranges, tsp + Tbsp, cups + ml), and printing amounts
 * nicely. The ShoppingItem contract is unchanged; aisle categories are computed at render time
 * (see grocery-categories.ts).
 */
import { getDisplayIngredientText } from "./conversion.js";
import { isRangeValue, maxOfValue } from "./format-internal.js";
import { categorizeIngredient } from "./grocery-categories.js";
import { inflectIngredientPhrase, singularizeNoun } from "./inflection.js";
import { parseIngredientQuantity } from "./ingredient-quantities.js";
import { formatIngredientQuantity } from "./quantity-format.js";
import { MAX_SHOPPING_ITEM_TEXT_LENGTH } from "./shopping.js";
import { canonicalUnit, getUnitDefinition, UNIT_ALIAS_LOOKUP } from "./units.js";

import type { IngredientUnitsPreference } from "./conversion.js";
import type { ShoppingCategoryId } from "./grocery-categories.js";
import type { Recipe } from "./recipe-schema.js";
import type { ShoppingQuantity } from "./shopping.js";

/** One line headed for a shopping list, with the recipe it came from. */
export type ShoppingInput = {
  text: string;
  recipeId?: string | undefined;
  recipeTitle?: string | undefined;
  section?: string | undefined;
};

/** An amount on a shopping item. Both parts are optional, like on ShoppingItem. */
export type ShoppingAmount = {
  qty?: ShoppingQuantity | null | undefined;
  unit?: string | null | undefined;
};

/** A shopping line parsed into the ShoppingItem fields. */
export type ParsedShoppingLine = {
  text: string;
  qty?: ShoppingQuantity | undefined;
  unit?: string | undefined;
};

export type AggregatedShoppingItem = {
  /** canonicalIngredientKey of the item; entries with incompatible units share a key. */
  key: string;
  /** Display name, inflected to agree with the summed amount ("large eggs"). */
  text: string;
  qty?: ShoppingQuantity | undefined;
  unit?: string | undefined;
  category: ShoppingCategoryId;
  /** Recipes that contributed, in first-seen order, without duplicates. */
  recipeIds: string[];
  recipeTitles: string[];
  sections: string[];
  /** The input lines merged into this item. */
  sourceTexts: string[];
};

export type MergeableShoppingItem = ShoppingAmount & {
  text: string;
  isDeleted?: boolean | undefined;
};

export type RecipeShoppingInputOptions = {
  /** Stored on each input; defaults to none. */
  recipeId?: string | undefined;
  scale?: number | undefined;
  units?: IngredientUnitsPreference | undefined;
  /** Ingredient indexes to include (all when omitted). */
  selected?: ReadonlySet<number> | readonly number[] | ((index: number) => boolean) | undefined;
};

export type MergeShoppingOptions = {
  /**
   * Sum amounts across compatible units (tsp + Tbsp, cups + ml, g + oz). Defaults to true; with
   * false only identical units merge, like the apps' original lists.
   */
  convertUnits?: boolean | undefined;
};

const MAX_RECIPE_TITLE_LENGTH_ON_ITEM = 200;
const MAX_SECTION_LENGTH_ON_ITEM = 120;
const HIGH_SURROGATE_END_PATTERN = /[\uD800-\uDBFF]$/u;
const PARENTHETICAL_PATTERN = /\s*(?:\([^)]*\)|\[[^\]]*\])\s*/gu;
const NOTE_START_PATTERN = /[,;]/u;
/** Footnote marks and stray punctuation left at the end of a name ("water*"). */
const TRAILING_MARKS_PATTERN = /[\s*†‡.:]+$/u;
const TRAILING_NOTE_PATTERN =
  /\s+(?:to taste|as needed|if needed|for (?:serving|garnish|garnishing|dusting|frying|greasing)|optional|divided|plus more.*)$/iu;
const WHITESPACE_PATTERN = /\s+/gu;
const DIACRITIC_PATTERN = /[̀-ͯ]/gu;
const NON_WORD_PATTERN = /[^a-z0-9\s-]+/gu;
const HYPHEN_PATTERN = /-/gu;
const OR_ALTERNATIVE_PATTERN = /\s+(?:or|and\/or)\s+.*$/u;
const LEADING_ARTICLE_PATTERN = /^(?:a|an|the|some)\s+/u;

const clip = (text: string, maxLength: number): string =>
  text.length <= maxLength
    ? text
    : text.slice(0, maxLength).replace(HIGH_SURROGATE_END_PATTERN, "").trimEnd();

/**
 * Words that describe preparation, size or freshness rather than what to buy. Deliberately
 * missing: words that change the product ("ground" beef, "crushed" tomatoes, "dried" oregano,
 * "smoked" paprika, "unsalted" butter, "hot" sauce, "frozen" peas).
 */
const DESCRIPTOR_WORDS = new Set([
  "about",
  "approximately",
  "beaten",
  "boneless",
  "chilled",
  "chopped",
  "coarsely",
  "cold",
  "cored",
  "cubed",
  "deseeded",
  "deveined",
  "diced",
  "divided",
  "drained",
  "extra",
  "extra-large",
  "finely",
  "fresh",
  "freshly",
  "good",
  "good-quality",
  "grated",
  "halved",
  "jumbo",
  "julienned",
  "juiced",
  "large",
  "lightly",
  "loosely",
  "medium",
  "medium-large",
  "melted",
  "minced",
  "optional",
  "organic",
  "packed",
  "peeled",
  "pitted",
  "quality",
  "quartered",
  "rinsed",
  "ripe",
  "roughly",
  "shredded",
  "skinless",
  "sliced",
  "small",
  "softened",
  "store-bought",
  "taste",
  "thinly",
  "trimmed",
  "whisked",
  "zested"
]);

/** Different names for the same thing on a shopping list. Keys and values are canonical keys. */
const SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["scallion", "green onion"],
  ["spring onion", "green onion"],
  ["garbanzo bean", "chickpea"],
  ["garbanzo", "chickpea"],
  ["confectioner sugar", "powdered sugar"],
  ["confectioners sugar", "powdered sugar"],
  ["icing sugar", "powdered sugar"],
  ["all-purpose flour", "flour"],
  ["all purpose flour", "flour"],
  ["plain flour", "flour"],
  ["unbleached all-purpose flour", "flour"],
  ["white sugar", "sugar"],
  ["granulated sugar", "sugar"],
  ["caster sugar", "sugar"],
  ["extra-virgin olive oil", "olive oil"],
  ["extra virgin olive oil", "olive oil"],
  ["coriander leaf", "cilantro"],
  ["courgette", "zucchini"],
  ["aubergine", "eggplant"],
  ["capsicum", "bell pepper"],
  ["heavy whipping cream", "heavy cream"],
  ["whipping cream", "heavy cream"],
  ["double cream", "heavy cream"],
  ["table salt", "salt"],
  ["fine salt", "salt"]
]);

/** Count units that sometimes follow the noun ("2 garlic cloves", "3 celery stalks"). */
const POSTFIX_COUNT_UNITS = new Set([
  "clove",
  "sprig",
  "stalk",
  "rib",
  "head",
  "bunch",
  "piece",
  "slice",
  "leaf",
  "strip",
  "ear"
]);

/** Items most kitchens always have; apps can offer to hide them. */
const PANTRY_STAPLE_KEYS = new Set([
  "water",
  "ice",
  "salt",
  "pepper",
  "black pepper",
  "salt and pepper",
  "ground black pepper",
  "ground pepper",
  "salt and black pepper",
  "kosher salt",
  "sea salt",
  "hot water",
  "warm water",
  "cold water",
  "lukewarm water",
  "boiling water",
  "ice water",
  "cooking spray",
  "nonstick cooking spray",
  "nonstick spray"
]);

const foldText = (text: string): string =>
  text.normalize("NFD").replace(DIACRITIC_PATTERN, "").toLowerCase();

/**
 * The item name worth putting on a list: prep notes after a comma, parentheticals and trailing
 * phrases such as "to taste" or "for serving" are dropped ("chickpeas, drained and rinsed" →
 * "chickpeas"). Falls back to the trimmed input when nothing would be left.
 */
export const cleanShoppingItemName = (text: string): string => {
  // Parentheticals go first: their commas ("(skim, 1% or whole)") are not the end of the name.
  const withoutNotes = text.replace(PARENTHETICAL_PATTERN, " ");
  const noteStart = NOTE_START_PATTERN.exec(withoutNotes);
  const head = noteStart ? withoutNotes.slice(0, noteStart.index) : withoutNotes;
  const cleaned = head
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .replace(TRAILING_NOTE_PATTERN, "")
    .replace(TRAILING_MARKS_PATTERN, "")
    .trim();

  return cleaned.length > 0 ? cleaned : text.replace(WHITESPACE_PATTERN, " ").trim();
};

/**
 * A stable key for "the same thing to buy": lowercase, diacritics folded, notes and
 * parentheticals dropped, preparation and size words removed (but product-defining ones such
 * as "ground", "crushed", "dried" kept), nouns singularized, a trailing count unit dropped
 * ("garlic cloves" → "garlic") and common synonyms unified ("scallions" → "green onion").
 */
export const canonicalIngredientKey = (text: string): string => {
  const parsed = parseIngredientQuantity(text);
  const name = cleanShoppingItemName(parsed.confident ? parsed.item : text);
  const folded = foldText(name)
    .replace(OR_ALTERNATIVE_PATTERN, "")
    .replace(NON_WORD_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .replace(LEADING_ARTICLE_PATTERN, "");
  const tokens = folded
    .split(" ")
    .filter((token) => token.length > 0 && !DESCRIPTOR_WORDS.has(token))
    .map((token) => (token.includes("-") ? token : singularizeNoun(token)));

  if (tokens.length > 1 && POSTFIX_COUNT_UNITS.has(tokens[tokens.length - 1] ?? "")) {
    tokens.pop();
  }

  const key = tokens.join(" ");
  const fallback = folded.length > 0 ? folded : foldText(text).trim();
  const resolved = key.length > 0 ? key : fallback;

  return SYNONYMS.get(resolved) ?? SYNONYMS.get(resolved.replace(HYPHEN_PATTERN, " ")) ?? resolved;
};

/** True for items most kitchens always have (water, salt, pepper, cooking spray). */
export const isPantryStaple = (text: string): boolean =>
  PANTRY_STAPLE_KEYS.has(canonicalIngredientKey(text));

const toShoppingQuantity = (
  qty: number | { min: number; max: number } | null
): ShoppingQuantity | undefined => {
  if (qty == null) {
    return undefined;
  }

  if (!isRangeValue(qty)) {
    return qty > 0 && Number.isFinite(qty) ? qty : undefined;
  }

  // The shopping contract requires positive range ends: "0-1 tsp salt" is "1 tsp salt".
  if (qty.min <= 0) {
    return qty.max > 0 ? qty.max : undefined;
  }

  return qty.min === qty.max ? qty.min : { min: qty.min, max: qty.max };
};

/**
 * Parses a shopping line into ShoppingItem fields, ready for the ShoppingItem schema: the text
 * is the cleaned item name (≤ 200 chars) with any package size kept ("chickpeas (15 oz)"), the
 * unit is canonical, a postfix count unit becomes the unit ("2 garlic cloves" → 2 clove garlic)
 * and ranges never start at zero. Lines without an amount keep their cleaned text only.
 */
export const parseShoppingLine = (line: string): ParsedShoppingLine => {
  const trimmed = line.replace(WHITESPACE_PATTERN, " ").trim();
  const parsed = parseIngredientQuantity(trimmed);

  if (!parsed.confident) {
    return { text: clip(cleanShoppingItemName(trimmed), MAX_SHOPPING_ITEM_TEXT_LENGTH) };
  }

  let name = cleanShoppingItemName(parsed.item);
  let unit = parsed.unit;

  if (unit == null) {
    const words = name.split(" ");
    const last = words[words.length - 1] ?? "";
    const postfix = UNIT_ALIAS_LOOKUP.get(singularizeNoun(last).toLowerCase());

    if (words.length > 1 && postfix && POSTFIX_COUNT_UNITS.has(postfix.canonical)) {
      unit = postfix.canonical;
      name = words.slice(0, -1).join(" ");
    }
  }

  if (parsed.packageSize) {
    name = `${name} (${parsed.packageSize.text})`.trim();
  }

  const qty = toShoppingQuantity(parsed.qty);

  return {
    text: clip(name.length > 0 ? name : trimmed, MAX_SHOPPING_ITEM_TEXT_LENGTH),
    ...(qty == null ? {} : { qty }),
    ...(unit == null ? {} : { unit })
  };
};

const addValues = (left: ShoppingQuantity, right: ShoppingQuantity): ShoppingQuantity => {
  if (!isRangeValue(left) && !isRangeValue(right)) {
    return left + right;
  }

  const leftMin = isRangeValue(left) ? left.min : left;
  const leftMax = isRangeValue(left) ? left.max : left;
  const rightMin = isRangeValue(right) ? right.min : right;
  const rightMax = isRangeValue(right) ? right.max : right;
  return { min: leftMin + rightMin, max: leftMax + rightMax };
};

/**
 * Adds two shopping quantities without ever dropping one: number + number, range + range and
 * number + range (the case the apps' copies returned `undefined` for) all sum; when only one
 * side has an amount it wins. Units are the caller's concern; see `addShoppingAmounts`.
 */
export const addShoppingQuantities = (
  left: ShoppingQuantity | null | undefined,
  right: ShoppingQuantity | null | undefined
): ShoppingQuantity | null | undefined => {
  if (left == null) {
    return right;
  }

  if (right == null) {
    return left;
  }

  return addValues(left, right);
};

const multiply = (value: ShoppingQuantity, factor: number): ShoppingQuantity =>
  isRangeValue(value) ? { min: value.min * factor, max: value.max * factor } : value * factor;

/**
 * Adds two amounts when their units are compatible and returns null when they are not (volume
 * vs weight, cups vs cans, unitless vs measured). With `convertUnits` (default), different
 * volume or weight units are summed in the larger unit ("2 tsp" + "1 Tbsp" → "1 ⅔ Tbsp",
 * "1 cup" + "250 ml" → "2.06 cups"), falling back to the smaller one when the total is less
 * than one of the larger. An amount-less side never blocks a merge and never loses the other
 * side's amount.
 */
export const addShoppingAmounts = (
  left: ShoppingAmount,
  right: ShoppingAmount,
  options: MergeShoppingOptions = {}
): { qty?: ShoppingQuantity | undefined; unit?: string | undefined } | null => {
  const leftUnit = left.unit ? (canonicalUnit(left.unit) ?? left.unit.trim().toLowerCase()) : null;
  const rightUnit = right.unit
    ? (canonicalUnit(right.unit) ?? right.unit.trim().toLowerCase())
    : null;
  const leftQty = left.qty ?? undefined;
  const rightQty = right.qty ?? undefined;
  const result = (
    qty: ShoppingQuantity | undefined,
    unit: string | null
  ): { qty?: ShoppingQuantity | undefined; unit?: string | undefined } => ({
    ...(qty == null ? {} : { qty }),
    ...(unit == null ? {} : { unit })
  });

  if (leftQty == null || rightQty == null) {
    // "Salt to taste" + "1 tsp salt": keep the amount that exists.
    return leftQty == null
      ? result(rightQty, rightUnit ?? leftUnit)
      : result(leftQty, leftUnit ?? rightUnit);
  }

  if (leftUnit === rightUnit) {
    return result(addValues(leftQty, rightQty), leftUnit);
  }

  if (options.convertUnits === false || leftUnit == null || rightUnit == null) {
    return null;
  }

  const leftDefinition = getUnitDefinition(leftUnit);
  const rightDefinition = getUnitDefinition(rightUnit);

  if (
    !leftDefinition?.base ||
    !rightDefinition?.base ||
    leftDefinition.kind === "count" ||
    leftDefinition.kind !== rightDefinition.kind
  ) {
    return null;
  }

  const totalBase = addValues(
    multiply(leftQty, leftDefinition.base),
    multiply(rightQty, rightDefinition.base)
  );
  const [larger, smaller] =
    leftDefinition.base >= rightDefinition.base
      ? [leftDefinition, rightDefinition]
      : [rightDefinition, leftDefinition];
  const inLarger = multiply(totalBase, 1 / (larger.base ?? 1));
  const target = maxOfValue(inLarger) >= 1 ? larger : smaller;

  return result(multiply(totalBase, 1 / (target.base ?? 1)), target.canonical);
};

/**
 * Pretty text for a shopping item: "2 cups flour", "1 ½ cans chickpeas (15 oz)", "3 large
 * eggs", "salt". Quantities use friendly fractions, never float noise.
 */
export const formatShoppingItemText = (item: {
  text: string;
  qty?: ShoppingQuantity | null | undefined;
  unit?: string | null | undefined;
}): string => {
  const amount = formatIngredientQuantity(item.qty ?? null, item.unit ?? null);
  return amount.length > 0 ? `${amount} ${item.text}`.trim() : item.text.trim();
};

const pushUnique = (list: string[], value: string | undefined, maxLength: number): void => {
  const trimmed = value?.trim();

  if (trimmed && !list.includes(clip(trimmed, maxLength))) {
    list.push(clip(trimmed, maxLength));
  }
};

const countOf = (qty: ShoppingQuantity | undefined): number | null =>
  qty == null ? null : maxOfValue(qty);

/**
 * Re-inflects a unitless item's name for a new total ("large egg" + 2 → "large eggs"), guarded
 * so mass nouns written with a mismatched number are left alone.
 */
const nameForTotal = (
  text: string,
  unit: string | undefined,
  writtenQty: ShoppingQuantity | undefined,
  totalQty: ShoppingQuantity | undefined
): string => {
  const written = countOf(writtenQty);
  const total = countOf(totalQty);

  if (unit != null || written == null || total == null) {
    return text;
  }

  return inflectIngredientPhrase(text, written, total);
};

/**
 * Merges shopping inputs into one list: lines with the same canonical key and compatible units
 * become one item with summed amounts; every contributing recipe is kept (recipeTitles[]).
 * Items keep first-seen order. Incompatible amounts of the same thing ("2 cups flour" and
 * "100 g flour" without conversion) stay separate entries sharing a key.
 */
export const mergeShoppingInputs = (
  inputs: readonly ShoppingInput[],
  options: MergeShoppingOptions = {}
): AggregatedShoppingItem[] => {
  const merged: Array<AggregatedShoppingItem & { writtenQty?: ShoppingQuantity | undefined }> = [];

  for (const input of inputs) {
    const line = parseShoppingLine(input.text);

    if (line.text.length === 0) {
      continue;
    }

    const key = canonicalIngredientKey(input.text);
    let target: (typeof merged)[number] | undefined;
    let combined: ReturnType<typeof addShoppingAmounts> = null;

    for (const candidate of merged) {
      if (candidate.key !== key) {
        continue;
      }

      combined = addShoppingAmounts(candidate, line, options);

      if (combined) {
        target = candidate;
        break;
      }
    }

    if (!target || !combined) {
      const item: (typeof merged)[number] = {
        key,
        text: line.text,
        ...(line.qty == null ? {} : { qty: line.qty }),
        ...(line.unit == null ? {} : { unit: line.unit }),
        category: categorizeIngredient(input.text),
        recipeIds: [],
        recipeTitles: [],
        sections: [],
        sourceTexts: [input.text],
        ...(line.qty == null ? {} : { writtenQty: line.qty })
      };
      pushUnique(item.recipeIds, input.recipeId, 180);
      pushUnique(item.recipeTitles, input.recipeTitle, MAX_RECIPE_TITLE_LENGTH_ON_ITEM);
      pushUnique(item.sections, input.section, MAX_SECTION_LENGTH_ON_ITEM);
      merged.push(item);
      continue;
    }

    if (target.writtenQty == null && line.qty != null) {
      target.writtenQty = line.qty;
      target.text = line.text;
    }

    target.qty = combined.qty;
    target.unit = combined.unit;

    if (combined.qty == null) {
      delete target.qty;
    }

    if (combined.unit == null) {
      delete target.unit;
    }

    target.sourceTexts.push(input.text);
    pushUnique(target.recipeIds, input.recipeId, 180);
    pushUnique(target.recipeTitles, input.recipeTitle, MAX_RECIPE_TITLE_LENGTH_ON_ITEM);
    pushUnique(target.sections, input.section, MAX_SECTION_LENGTH_ON_ITEM);
  }

  return merged.map(({ writtenQty, ...item }) => ({
    ...item,
    text: nameForTotal(item.text, item.unit, writtenQty, item.qty)
  }));
};

/**
 * Index of the live item in `items` that `candidate` should merge into: same canonical key and
 * compatible amounts. -1 when there is none. Deleted items never match.
 */
export const findMergeableShoppingItem = <T extends MergeableShoppingItem>(
  items: readonly T[],
  candidate: MergeableShoppingItem,
  options: MergeShoppingOptions = {}
): number => {
  if (candidate.isDeleted) {
    return -1;
  }

  const key = canonicalIngredientKey(candidate.text);

  return items.findIndex(
    (item) =>
      !item.isDeleted &&
      canonicalIngredientKey(item.text) === key &&
      addShoppingAmounts(item, candidate, options) != null
  );
};

/**
 * Drop-in core of the apps' `mergeShoppingItems(existing, incoming)`: each incoming item merges
 * into a matching live item (see `findMergeableShoppingItem`) or is appended. `combine` builds
 * the merged record from the existing item, the incoming one and the summed amount/name, so
 * each app keeps its own sync bookkeeping (checked state, sync status, updatedAt).
 */
export const mergeShoppingItemLists = <T extends MergeableShoppingItem>(
  existingItems: readonly T[],
  incomingItems: readonly T[],
  combine: (
    existing: T,
    incoming: T,
    merged: { text: string; qty?: ShoppingQuantity | undefined; unit?: string | undefined }
  ) => T,
  options: MergeShoppingOptions = {}
): T[] => {
  const result = [...existingItems];

  for (const incoming of incomingItems) {
    const index = findMergeableShoppingItem(result, incoming, options);
    const existing = index >= 0 ? result[index] : undefined;
    const amount = existing ? addShoppingAmounts(existing, incoming, options) : null;

    if (!existing || !amount) {
      result.push(incoming);
      continue;
    }

    const writtenQty = existing.qty ?? incoming.qty ?? undefined;
    result[index] = combine(existing, incoming, {
      ...amount,
      text: nameForTotal(existing.text, amount.unit, writtenQty, amount.qty)
    });
  }

  return result;
};

const isSelected = (selected: RecipeShoppingInputOptions["selected"], index: number): boolean => {
  if (selected == null) {
    return true;
  }

  if (typeof selected === "function") {
    return selected(index);
  }

  return "has" in selected ? selected.has(index) : selected.includes(index);
};

/**
 * Shopping inputs for a recipe's ingredients at a scale and in a unit system, optionally only
 * the selected ingredient indexes. Lines keep their written text when nothing changes, as the
 * apps' add-to-list sheets always did.
 */
export const recipeIngredientsToShoppingInputs = (
  recipe: Pick<Recipe, "ingredients" | "title">,
  options: RecipeShoppingInputOptions = {}
): ShoppingInput[] =>
  recipe.ingredients.flatMap((ingredient, index) => {
    if (!isSelected(options.selected, index)) {
      return [];
    }

    return [
      {
        ...(options.recipeId ? { recipeId: options.recipeId } : {}),
        recipeTitle: clip(recipe.title, MAX_RECIPE_TITLE_LENGTH_ON_ITEM),
        ...(ingredient.section
          ? { section: clip(ingredient.section, MAX_SECTION_LENGTH_ON_ITEM) }
          : {}),
        text: getDisplayIngredientText(ingredient.text, {
          scale: options.scale ?? 1,
          units: options.units ?? "original",
          keepOriginalText: true
        })
      }
    ];
  });
