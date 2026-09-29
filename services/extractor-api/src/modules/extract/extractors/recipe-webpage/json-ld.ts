import {
  isHttpUrl,
  MAX_RECIPE_KEYWORD_COUNT,
  parseDuration
} from "../../../../../../../packages/recipe-domain/src/index.js";
import { htmlFragmentToLines, htmlFragmentToText } from "../html-text.js";

/*
 * Readers for schema.org Recipe JSON-LD as sites actually publish it. Every property can arrive
 * as a string, a number, an array, a nested object or null, and strings may carry markup, so
 * nothing here assumes a shape: unexpected values read as "absent" instead of throwing (a
 * string recipeIngredient used to crash the whole import with "values.map is not a function").
 */
export type JsonRecord = Record<string, unknown>;

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* "Recipe", "schema:Recipe" and "https://schema.org/Recipe" all name the same type. */
const readTypeNames = (node: JsonRecord): string[] => {
  const rawType = node["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];

  return types
    .filter((type): type is string => typeof type === "string")
    .map((type) => (type.split(/[/:#]/u).pop() ?? type).trim().toLowerCase());
};

export const hasJsonLdType = (node: JsonRecord, typeName: string): boolean =>
  readTypeNames(node).includes(typeName);

/** A single line of plain text, or null when the value holds none. */
export const readJsonLdText = (value: unknown, depth = 0): string | null => {
  if (depth > 4 || value == null) {
    return null;
  }

  if (typeof value === "string") {
    const text = htmlFragmentToText(value);
    return text.length > 0 ? text : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = readJsonLdText(entry, depth + 1);

      if (text) {
        return text;
      }
    }

    return null;
  }

  if (isJsonRecord(value)) {
    return readJsonLdText(value["@value"] ?? value.name ?? value.text, depth + 1);
  }

  return null;
};

/** Every text entry of a string-or-array property, joined with ", " (recipeCuisine, recipeCategory). */
export const readJsonLdTextList = (value: unknown): string | null => {
  const entries = (Array.isArray(value) ? value : [value])
    .map((entry) => readJsonLdText(entry))
    .filter((entry): entry is string => entry !== null);
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = entry.toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  return unique.length > 0 ? unique.join(", ") : null;
};

/** recipeIngredient: an array of lines, or one string of newline/markup-separated lines. */
export const readJsonLdIngredientLines = (value: unknown): string[] => {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];

  return entries.flatMap((entry): string[] => {
    if (typeof entry === "string") {
      return htmlFragmentToLines(entry);
    }

    if (typeof entry === "number" && Number.isFinite(entry)) {
      return [String(entry)];
    }

    if (isJsonRecord(entry)) {
      const text = readJsonLdText(entry.text ?? entry.name ?? entry["@value"]);
      return text ? [text] : [];
    }

    return [];
  });
};

const maxInstructionDepth = 6;
const maxInstructionLines = 1_000;

const collectInstructionLines = (value: unknown, depth: number, lines: string[]): void => {
  if (depth > maxInstructionDepth || lines.length >= maxInstructionLines || value == null) {
    return;
  }

  if (typeof value === "string") {
    lines.push(...htmlFragmentToLines(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInstructionLines(entry, depth + 1, lines);
    }

    return;
  }

  if (!isJsonRecord(value)) {
    return;
  }

  const children = value.itemListElement;
  const isContainer =
    hasJsonLdType(value, "howtosection") ||
    hasJsonLdType(value, "itemlist") ||
    typeof value.text !== "string";

  /* HowToSection / ItemList: the steps are the children (the section name is not a step). */
  if (children != null && isContainer) {
    collectInstructionLines(children, depth + 1, lines);
    return;
  }

  /* HowToStep / HowToDirection / HowToTip: its text, else its name. */
  const text = typeof value.text === "string" ? value.text : value.name;

  if (typeof text === "string") {
    lines.push(...htmlFragmentToLines(text));
  }
};

/** recipeInstructions in any published shape, flattened to step lines in order. */
export const readJsonLdInstructionLines = (value: unknown): string[] => {
  const lines: string[] = [];
  collectInstructionLines(value, 0, lines);
  return lines;
};

/**
 * recipeYield: "4 servings", 4, or ["4", "4 servings"]. For arrays the most descriptive entry
 * (one with words, not just a number) wins.
 */
export const readJsonLdYield = (value: unknown): string | null => {
  if (!Array.isArray(value)) {
    return readJsonLdText(value);
  }

  const entries = value
    .map((entry) => readJsonLdText(entry))
    .filter((entry): entry is string => entry !== null);

  return entries.find((entry) => /\p{L}/u.test(entry)) ?? entries[0] ?? null;
};

export const readJsonLdDurationMinutes = (value: unknown): number | null =>
  typeof value === "string" || typeof value === "number" ? parseDuration(value) : null;

const readPersonName = (value: unknown): string | null => {
  const name = isJsonRecord(value) ? readJsonLdText(value.name) : readJsonLdText(value);

  /* Some sites put the author's profile URL where the name belongs. */
  return name && !isHttpUrl(name) ? name : null;
};

/** author: a name, a Person/Organization, or an array of them (joined with ", "). */
export const readJsonLdAuthor = (value: unknown): string | null => {
  const names = (Array.isArray(value) ? value : [value])
    .map(readPersonName)
    .filter((name): name is string => name !== null);
  const unique = [...new Set(names)].slice(0, 3);

  return unique.length > 0 ? unique.join(", ") : null;
};

const keywordSeparatorPattern = /[,;\n]/u;

/** keywords: a comma-separated string or an array; split, trimmed, de-duplicated and capped. */
export const readJsonLdKeywords = (value: unknown): string[] | null => {
  const rawEntries = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== "string") {
      continue;
    }

    for (const part of htmlFragmentToText(rawEntry).split(keywordSeparatorPattern)) {
      const keyword = part.replace(/\s+/gu, " ").trim();
      const key = keyword.toLowerCase();

      if (keyword.length === 0 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      keywords.push(keyword);

      if (keywords.length >= MAX_RECIPE_KEYWORD_COUNT) {
        return keywords;
      }
    }
  }

  return keywords.length > 0 ? keywords : null;
};

/** video: a VideoObject (or several); its contentUrl, embedUrl or url when it is http(s). */
export const readJsonLdVideoUrl = (value: unknown): string | null => {
  for (const entry of Array.isArray(value) ? value : [value]) {
    const candidates = isJsonRecord(entry)
      ? [entry.contentUrl, entry.embedUrl, entry.url]
      : [entry];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && isHttpUrl(candidate.trim())) {
        return candidate.trim();
      }
    }
  }

  return null;
};

export interface JsonLdRecipeMatch {
  recipe: JsonRecord;
  /** The page's WebSite (or, failing that, Organization) name, for siteName. */
  siteName: string | null;
}

/* Pages with enormous @graph blocks still get a bounded walk. */
const maxJsonLdNodes = 2_000;

const scoreRecipeNode = (node: JsonRecord): number =>
  readJsonLdIngredientLines(node.recipeIngredient ?? node.ingredients).length +
  readJsonLdInstructionLines(node.recipeInstructions).length;

/**
 * The most complete Recipe node among the page's JSON-LD blocks (top level, arrays, @graph and
 * mainEntity), plus the site name from any WebSite/Organization node.
 */
export const findJsonLdRecipe = (blocks: readonly unknown[]): JsonLdRecipeMatch | null => {
  const recipes: JsonRecord[] = [];
  let websiteName: string | null = null;
  let organizationName: string | null = null;
  const queue: unknown[] = [...blocks];
  let visited = 0;

  while (queue.length > 0 && visited < maxJsonLdNodes) {
    const current = queue.shift();
    visited += 1;

    if (Array.isArray(current)) {
      queue.push(...(current as unknown[]));
      continue;
    }

    if (!isJsonRecord(current)) {
      continue;
    }

    if (hasJsonLdType(current, "recipe")) {
      recipes.push(current);
    } else if (hasJsonLdType(current, "website")) {
      websiteName ??= readJsonLdText(current.name);
    } else if (hasJsonLdType(current, "organization")) {
      organizationName ??= readJsonLdText(current.name);
    }

    for (const key of ["@graph", "mainEntity"]) {
      const nested = current[key];

      if (Array.isArray(nested) || isJsonRecord(nested)) {
        queue.push(nested);
      }
    }
  }

  let best: JsonRecord | null = null;
  let bestScore = -1;

  for (const recipe of recipes) {
    const score = scoreRecipeNode(recipe);

    if (score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  }

  return best ? { recipe: best, siteName: websiteName ?? organizationName } : null;
};
