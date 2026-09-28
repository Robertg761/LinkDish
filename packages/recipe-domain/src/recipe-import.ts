/**
 * Pure mappers from other apps' export formats into LinkDish recipes: Paprika's recipe JSON,
 * Mela's recipe JSON and schema.org JSON-LD (what most sites and several apps export). Reading
 * the ZIP/gzip containers is the caller's job; these functions only map one parsed JSON object.
 *
 * Every mapper returns `{ recipe, meta, warnings }`: `recipe` is a schema-valid Recipe or null
 * when the source lacks what LinkDish requires (a title, ingredients and steps); `meta` carries
 * the personal data (favorite, rating, notes, tags, photo) the app stores beside the recipe.
 */
import { decodeHtmlEntities, defuseTagOpeners } from "../../utils/src/index.js";

import { parseDuration } from "./durations.js";
import {
  computeMissingRecipeFields,
  isHttpUrl,
  MAX_RECIPE_AUTHOR_LENGTH,
  MAX_RECIPE_DESCRIPTION_LENGTH,
  MAX_RECIPE_INGREDIENT_COUNT,
  MAX_RECIPE_INGREDIENT_SECTION_LENGTH,
  MAX_RECIPE_INGREDIENT_TEXT_LENGTH,
  MAX_RECIPE_NUTRITION_VALUE_LENGTH,
  MAX_RECIPE_SERVINGS_LENGTH,
  MAX_RECIPE_STEP_COUNT,
  MAX_RECIPE_STEP_TEXT_LENGTH,
  MAX_RECIPE_TITLE_LENGTH,
  MAX_RECIPE_URL_LENGTH,
  recipeSchema
} from "./recipe-schema.js";
import { removeHtmlTags, trimEndMatching } from "./text-scan.js";

import type {
  Recipe,
  RecipeConfidence,
  RecipeImage,
  RecipeIngredient,
  RecipeNutrition,
  RecipeStep
} from "./recipe-schema.js";

export type ImportedRecipeMeta = {
  /** The recipe's source URL, or a synthetic linkdish.app URL when the export had none. */
  sourceUrl: string;
  /** True when `sourceUrl` was synthesized; apps may prefer their own placeholder. */
  sourceUrlSynthetic: boolean;
  favorite?: boolean | undefined;
  /** 1–5, or null when unrated. */
  rating?: number | null | undefined;
  notes?: string | null | undefined;
  tags?: string[] | undefined;
  /** ISO timestamp from the export, when it has one. */
  createdAt?: string | null | undefined;
  /** A small embedded photo as a data: URL (large photos are dropped with a warning). */
  photoDataUrl?: string | null | undefined;
  /** The exporting app's id for the recipe. */
  externalId?: string | undefined;
};

export type RecipeImportResult = {
  recipe: Recipe | null;
  meta: ImportedRecipeMeta;
  warnings: string[];
};

export type RecipeImportOptions = {
  /** Base for synthetic source URLs; the slug and a content hash are appended. */
  syntheticSourceBase?: string | undefined;
  /** Largest embedded photo kept, in base64 characters (default ~1.5 MB of text). */
  maxPhotoChars?: number | undefined;
};

export type SchemaOrgImportOptions = {
  /** The page the JSON-LD came from; preferred over the object's own `url`. */
  sourceUrl?: string | undefined;
};

const DEFAULT_MAX_PHOTO_CHARS = 1_500_000;
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 60;
const BREAK_TAG_PATTERN = /<br\s*\/?>|<\/p>|<\/li>/giu;
/** Tags that only appear once others are gone ("<scr<b>ipt>") need another pass; see stripMarkup. */
const MAX_MARKUP_PASSES = 4;
const LINE_SPLIT_PATTERN = /\r\n|\r|\n/u;
const INLINE_SPACE_PATTERN = /[ \t\u00a0]+/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const HEADER_MARK_PATTERN = /^#+\s*/u;
const STEP_NUMBER_PATTERN = /^\s*(?:step\s*)?\d{1,3}\s*[.):-]\s+/iu;
const BULLET_PATTERN = /^\s*[-•*▢□◦]\s+/u;
const DIGIT_PATTERN = /\d/u;
const SLUG_NON_WORD_PATTERN = /[^a-z0-9]+/gu;
const SLUG_EDGE_PATTERN = /^-+|-+$/gu;
const DIACRITIC_PATTERN = /[̀-ͯ]/gu;
const PAPRIKA_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/=\s]+$/u;
const NUTRITION_LINE_PATTERN = /^\s*([A-Za-z ]+?)\s*[:=]\s*(.+)$/u;
const TRAILING_COLON_PATTERN = /:$/u;
/** Trailing slashes come off the synthetic source base with a linear scan, not /\/+$/. */
const SLASH_CHARACTER = /\//u;
const KEYWORD_SEPARATOR_PATTERN = /[,;]/u;

const HIGH_SURROGATE_END_PATTERN = /[\uD800-\uDBFF]$/u;

const clip = (text: string, maxLength: number): string =>
  text.length <= maxLength
    ? text
    : text.slice(0, maxLength).replace(HIGH_SURROGATE_END_PATTERN, "").trimEnd();

/**
 * A URL the recipe schema accepts. A longer one is dropped like an invalid one, so an over-long
 * image or video link costs that field instead of the whole recipe.
 */
const isImportableUrl = (url: string): boolean =>
  url.length <= MAX_RECIPE_URL_LENGTH && isHttpUrl(url);

/** Text from an unknown JSON value: strings as-is, numbers stringified, anything else "". */
const asText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";

/**
 * Turns block tags into line breaks and drops the other tags (see removeHtmlTags for what is a
 * tag), passing again while a pass exposes a new tag, then defuses any "<" that could still open
 * one (an unclosed "<script", or nesting deeper than MAX_MARKUP_PASSES, which only hostile input
 * has). The pass limit keeps the work linear; defuseTagOpeners makes the result complete anyway.
 */
const stripMarkup = (text: string): string => {
  let stripped = text;

  for (let pass = 0; pass < MAX_MARKUP_PASSES; pass += 1) {
    const next = removeHtmlTags(stripped.replace(BREAK_TAG_PATTERN, "\n"));

    if (next === stripped) {
      break;
    }

    stripped = next;
  }

  return defuseTagOpeners(stripped);
};

/**
 * Plain text from an export field: markup stripped, entities decoded, and markup stripped
 * again, since some exports entity-encode their tags ("&lt;p&gt;Mix&lt;/p&gt;"). The second
 * pass reads tags as the first does, and as the extractor does after decoding: an encoded
 * "&lt;chef@example.com&gt;" stays text, while "&lt;your favorite&gt;" reads as a tag and goes.
 */
const cleanText = (value: unknown): string =>
  stripMarkup(decodeHtmlEntities(stripMarkup(asText(value))))
    .split(LINE_SPLIT_PATTERN)
    .map((line) => line.replace(INLINE_SPACE_PATTERN, " ").trim())
    .join("\n")
    .trim();

const oneLine = (value: unknown): string =>
  cleanText(value).replace(WHITESPACE_PATTERN, " ").trim();

const lines = (value: unknown): string[] =>
  cleanText(value)
    .split(LINE_SPLIT_PATTERN)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const firstText = (value: unknown): string => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = oneLine(entry);

      if (text) {
        return text;
      }
    }

    return "";
  }

  return oneLine(value);
};

const isHeaderLine = (line: string): boolean =>
  HEADER_MARK_PATTERN.test(line) ||
  (line.endsWith(":") && line.length <= 60 && !DIGIT_PATTERN.test(line));

const headerText = (line: string): string =>
  line.replace(HEADER_MARK_PATTERN, "").replace(TRAILING_COLON_PATTERN, "").trim();

/** Ingredient lines with "Section:" or "# Section" headers turned into sections. */
const toIngredients = (source: readonly string[], warnings: string[]): RecipeIngredient[] => {
  const ingredients: RecipeIngredient[] = [];
  let section: string | null = null;

  for (const raw of source) {
    const line = raw.replace(BULLET_PATTERN, "").trim();

    if (line.length === 0) {
      continue;
    }

    if (isHeaderLine(line)) {
      const name = headerText(line);
      section = name.length > 0 ? clip(name, MAX_RECIPE_INGREDIENT_SECTION_LENGTH) : null;
      continue;
    }

    ingredients.push({
      text: clip(line, MAX_RECIPE_INGREDIENT_TEXT_LENGTH),
      ...(section ? { section } : {})
    });
  }

  if (ingredients.length > MAX_RECIPE_INGREDIENT_COUNT) {
    warnings.push(`Only the first ${MAX_RECIPE_INGREDIENT_COUNT} ingredients were kept.`);
    return ingredients.slice(0, MAX_RECIPE_INGREDIENT_COUNT);
  }

  return ingredients;
};

/** Steps from text lines; numbering is dropped and "# Section" headers prefix the next step. */
const toSteps = (source: readonly string[], warnings: string[]): RecipeStep[] => {
  const texts: string[] = [];
  let pendingHeader: string | null = null;

  for (const raw of source) {
    const line = raw.replace(STEP_NUMBER_PATTERN, "").replace(BULLET_PATTERN, "").trim();

    if (line.length === 0) {
      continue;
    }

    if (HEADER_MARK_PATTERN.test(line) || (isHeaderLine(line) && line.length <= 40)) {
      pendingHeader = headerText(line);
      continue;
    }

    texts.push(pendingHeader ? `${pendingHeader}: ${line}` : line);
    pendingHeader = null;
  }

  if (texts.length > MAX_RECIPE_STEP_COUNT) {
    warnings.push(`Only the first ${MAX_RECIPE_STEP_COUNT} steps were kept.`);
  }

  return texts.slice(0, MAX_RECIPE_STEP_COUNT).map((text, index) => ({
    index: index + 1,
    text: clip(text, MAX_RECIPE_STEP_TEXT_LENGTH)
  }));
};

const NUTRITION_KEYS: ReadonlyArray<{ key: keyof RecipeNutrition; pattern: RegExp }> = [
  { key: "calories", pattern: /^(?:calories|energy|kcal)$/iu },
  { key: "protein", pattern: /^protein$/iu },
  { key: "carbohydrates", pattern: /^(?:carbs?|carbohydrates?|total carbohydrates?)$/iu },
  { key: "fat", pattern: /^(?:fat|total fat)$/iu },
  { key: "fiber", pattern: /^(?:fiber|fibre|dietary fiber)$/iu },
  { key: "sugar", pattern: /^(?:sugars?|total sugars?)$/iu },
  { key: "sodium", pattern: /^sodium$/iu }
];

const emptyNutrition = (): RecipeNutrition => ({
  calories: null,
  protein: null,
  carbohydrates: null,
  fat: null,
  fiber: null,
  sugar: null,
  sodium: null
});

const hasAnyNutrition = (nutrition: RecipeNutrition): boolean =>
  Object.values(nutrition).some((value) => value != null);

/** "Calories: 250\nFat: 10 g" → RecipeNutrition, or null when nothing is recognized. */
const parseNutritionText = (value: unknown): RecipeNutrition | null => {
  const nutrition = emptyNutrition();

  for (const line of lines(value)) {
    const match = NUTRITION_LINE_PATTERN.exec(line);
    const entry = match ? NUTRITION_KEYS.find(({ pattern }) => pattern.test(match[1] ?? "")) : null;

    if (match && entry) {
      nutrition[entry.key] =
        clip((match[2] ?? "").trim(), MAX_RECIPE_NUTRITION_VALUE_LENGTH) || null;
    }
  }

  return hasAnyNutrition(nutrition) ? nutrition : null;
};

/** 32-bit FNV-1a, hex. Stable content hash for synthetic ids. */
const hashText = (text: string): string => {
  let hash = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
};

const slugify = (text: string): string =>
  text
    .normalize("NFD")
    .replace(DIACRITIC_PATTERN, "")
    .toLowerCase()
    .replace(SLUG_NON_WORD_PATTERN, "-")
    .replace(SLUG_EDGE_PATTERN, "")
    .slice(0, 80)
    .replace(SLUG_EDGE_PATTERN, "") || "recipe";

const resolveSourceUrl = (
  candidates: readonly unknown[],
  app: string,
  title: string,
  identity: string,
  options: RecipeImportOptions
): { sourceUrl: string; synthetic: boolean } => {
  for (const candidate of candidates) {
    const url = asText(candidate).trim();

    if (url && isImportableUrl(url)) {
      return { sourceUrl: url, synthetic: false };
    }
  }

  const base = trimEndMatching(
    options.syntheticSourceBase ?? `https://linkdish.app/imports/${app}`,
    SLASH_CHARACTER
  );
  return { sourceUrl: `${base}/${slugify(title)}-${hashText(identity)}`, synthetic: true };
};

/** The first MAX_TAGS distinct tags, ignoring case; stops reading once it has them. */
const toTags = (value: unknown): string[] | undefined => {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (tags.length === MAX_TAGS) {
      break;
    }

    const tag = clip(oneLine(entry), MAX_TAG_LENGTH);
    const key = tag.toLowerCase();

    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }

  return tags.length > 0 ? tags : undefined;
};

const toRating = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : Number.parseFloat(asText(value));
  return Number.isFinite(numeric) && numeric >= 1 ? Math.min(5, Math.round(numeric)) : null;
};

const toMinutes = (value: unknown): number | null =>
  parseDuration(typeof value === "number" ? value : asText(value));

const importConfidence = (
  summary: string,
  provenance: "jsonld" | "visible-text",
  recipe: Pick<Recipe, "servings" | "prepTimeMinutes" | "cookTimeMinutes" | "nutrition">
): RecipeConfidence => ({
  score: 0.95,
  summary,
  missingFields: [],
  notes: [],
  fieldProvenance: {
    title: provenance,
    ingredients: provenance,
    steps: provenance,
    servings: recipe.servings == null ? null : provenance,
    prepTimeMinutes: recipe.prepTimeMinutes == null ? null : provenance,
    cookTimeMinutes: recipe.cookTimeMinutes == null ? null : provenance,
    nutrition: recipe.nutrition == null ? null : provenance
  }
});

type RecipeDraft = Omit<Recipe, "confidence">;

/** Validates a draft; a missing title, ingredients or steps yields null with a warning. */
const finalizeRecipe = (
  draft: RecipeDraft,
  summary: string,
  provenance: "jsonld" | "visible-text",
  warnings: string[]
): Recipe | null => {
  if (!draft.title) {
    warnings.push("The recipe has no title.");
  }

  if (draft.ingredients.length === 0) {
    warnings.push("The recipe has no ingredients, so it can't be imported.");
  }

  if (draft.steps.length === 0) {
    warnings.push("The recipe has no steps, so it can't be imported.");
  }

  if (!draft.title || draft.ingredients.length === 0 || draft.steps.length === 0) {
    return null;
  }

  const confidence = importConfidence(summary, provenance, draft);
  const parsed = recipeSchema.safeParse({
    ...draft,
    confidence: { ...confidence, missingFields: computeMissingRecipeFields(draft) }
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    warnings.push(
      `The recipe could not be imported (${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}).`
    );
    return null;
  }

  return parsed.data;
};

const optionalText = (value: string, maxLength: number): string | null =>
  value.length > 0 ? clip(value, maxLength) : null;

const toIsoTimestamp = (value: unknown): string | null => {
  const text = asText(value).trim();

  if (!text) {
    return null;
  }

  const paprika = PAPRIKA_DATE_PATTERN.exec(text);
  const date = new Date(paprika ? `${paprika[1]}T${paprika[2]}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const photoDataUrl = (
  base64: unknown,
  options: RecipeImportOptions,
  warnings: string[]
): string | null => {
  const data = asText(base64).trim();

  if (!data) {
    return null;
  }

  if (data.length > (options.maxPhotoChars ?? DEFAULT_MAX_PHOTO_CHARS)) {
    warnings.push("The photo was too large to keep.");
    return null;
  }

  if (!BASE64_PATTERN.test(data)) {
    warnings.push("The photo data was unreadable.");
    return null;
  }

  return `data:image/jpeg;base64,${data.replace(WHITESPACE_PATTERN, "")}`;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Maps one recipe from a Paprika export (the JSON inside each gzipped entry of a
 * .paprikarecipes file): name, ingredients and directions (newline text), servings,
 * prep/cook/total time strings, source_url, notes, nutritional_info, categories, rating,
 * on_favorites, created and photo_data (kept as a data: URL only when small).
 */
export const paprikaRecipeToRecipe = (
  json: unknown,
  options: RecipeImportOptions = {}
): RecipeImportResult => {
  const source = recordOf(json);
  const warnings: string[] = [];
  const title = clip(oneLine(source.name), MAX_RECIPE_TITLE_LENGTH);
  const ingredientLines = lines(source.ingredients);
  const { sourceUrl, synthetic } = resolveSourceUrl(
    [source.source_url, source.source],
    "paprika",
    title,
    asText(source.uid) || `${title}\n${ingredientLines.join("\n")}`,
    options
  );
  const imageUrl = asText(source.image_url).trim();
  const image: RecipeImage | null =
    imageUrl && isImportableUrl(imageUrl) ? { url: imageUrl, source: "content" } : null;
  const draft: RecipeDraft = {
    title,
    sourceUrl,
    sourceType: synthetic ? "unknown" : "recipe-webpage",
    image,
    ingredients: toIngredients(ingredientLines, warnings),
    steps: toSteps(lines(source.directions), warnings),
    servings: optionalText(oneLine(source.servings), MAX_RECIPE_SERVINGS_LENGTH),
    prepTimeMinutes: toMinutes(source.prep_time),
    cookTimeMinutes: toMinutes(source.cook_time),
    totalTimeMinutes: toMinutes(source.total_time),
    nutrition: parseNutritionText(source.nutritional_info),
    description: optionalText(cleanText(source.description), MAX_RECIPE_DESCRIPTION_LENGTH),
    siteName: optionalText(oneLine(source.source), 200)
  };
  const recipe = finalizeRecipe(draft, "Imported from Paprika.", "visible-text", warnings);
  const notes = cleanText(source.notes);
  const tags = toTags(source.categories);
  const favorite =
    source.on_favorites === true || source.on_favorites === 1 || source.on_favorites === "1";

  return {
    recipe,
    meta: {
      sourceUrl,
      sourceUrlSynthetic: synthetic,
      favorite,
      rating: toRating(source.rating),
      notes: notes.length > 0 ? notes : null,
      ...(tags ? { tags } : {}),
      createdAt: toIsoTimestamp(source.created),
      photoDataUrl: photoDataUrl(source.photo_data, options, warnings),
      ...(asText(source.uid) ? { externalId: asText(source.uid) } : {})
    },
    warnings
  };
};

/**
 * Maps one recipe from a Mela export (the JSON of a .melarecipe file): title, text
 * (description), ingredients and instructions (newline text, "# Group" headers), yield,
 * prepTime/cookTime/totalTime, link, notes, nutrition, categories, favorite and the first
 * base64 image.
 */
export const melaRecipeToRecipe = (
  json: unknown,
  options: RecipeImportOptions = {}
): RecipeImportResult => {
  const source = recordOf(json);
  const warnings: string[] = [];
  const title = clip(oneLine(source.title), MAX_RECIPE_TITLE_LENGTH);
  const ingredientLines = lines(source.ingredients);
  const { sourceUrl, synthetic } = resolveSourceUrl(
    [source.link],
    "mela",
    title,
    asText(source.id) || `${title}\n${ingredientLines.join("\n")}`,
    options
  );
  const draft: RecipeDraft = {
    title,
    sourceUrl,
    sourceType: synthetic ? "unknown" : "recipe-webpage",
    image: null,
    ingredients: toIngredients(ingredientLines, warnings),
    steps: toSteps(lines(source.instructions), warnings),
    servings: optionalText(oneLine(source.yield), MAX_RECIPE_SERVINGS_LENGTH),
    prepTimeMinutes: toMinutes(source.prepTime),
    cookTimeMinutes: toMinutes(source.cookTime),
    totalTimeMinutes: toMinutes(source.totalTime),
    nutrition: parseNutritionText(source.nutrition),
    description: optionalText(cleanText(source.text), MAX_RECIPE_DESCRIPTION_LENGTH)
  };
  const recipe = finalizeRecipe(draft, "Imported from Mela.", "visible-text", warnings);
  const notes = cleanText(source.notes);
  const tags = toTags(source.categories);
  const images = Array.isArray(source.images) ? (source.images as unknown[]) : [];

  return {
    recipe,
    meta: {
      sourceUrl,
      sourceUrlSynthetic: synthetic,
      favorite: source.favorite === true,
      notes: notes.length > 0 ? notes : null,
      ...(tags ? { tags } : {}),
      photoDataUrl: photoDataUrl(images[0], options, warnings),
      ...(asText(source.id) ? { externalId: asText(source.id) } : {})
    },
    warnings
  };
};

// --- schema.org JSON-LD --------------------------------------------------------------------------

const MAX_GRAPH_DEPTH = 4;

const hasRecipeType = (node: Record<string, unknown>): boolean => {
  const type = node["@type"];
  return Array.isArray(type)
    ? type.some((entry) => asText(entry).toLowerCase() === "recipe")
    : asText(type).toLowerCase() === "recipe";
};

/** The first schema.org Recipe node in a JSON-LD value (plain, array, or @graph). */
export const findSchemaOrgRecipe = (value: unknown, depth = 0): Record<string, unknown> | null => {
  if (depth > MAX_GRAPH_DEPTH || value == null || typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSchemaOrgRecipe(entry, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  }

  const node = value as Record<string, unknown>;

  if (hasRecipeType(node)) {
    return node;
  }

  return (
    findSchemaOrgRecipe(node["@graph"], depth + 1) ??
    findSchemaOrgRecipe(node.mainEntity, depth + 1)
  );
};

const names = (value: unknown): string[] => {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) =>
      typeof entry === "object" && entry !== null ? oneLine(recordOf(entry).name) : oneLine(entry)
    )
    .filter((name) => name.length > 0);
};

const instructionLines = (value: unknown, section: string | null, depth = 0): string[] => {
  if (depth > MAX_GRAPH_DEPTH || value == null) {
    return [];
  }

  if (typeof value === "string") {
    return lines(value).map((line, index) =>
      section && index === 0 ? `${section}: ${line}` : line
    );
  }

  if (Array.isArray(value)) {
    const result: string[] = [];

    for (const entry of value) {
      const entryLines = instructionLines(entry, result.length === 0 ? section : null, depth + 1);
      result.push(...entryLines);
    }

    return result;
  }

  const node = recordOf(value);
  const type = asText(node["@type"]).toLowerCase();

  if (type === "howtosection" || (node.itemListElement != null && type !== "howtostep")) {
    const sectionName = oneLine(node.name) || null;
    return instructionLines(node.itemListElement, sectionName, depth + 1);
  }

  const text = cleanText(node.text) || cleanText(node.name);
  return text ? instructionLines(text, section, depth + 1) : [];
};

const imageFrom = (value: unknown, depth = 0): RecipeImage | null => {
  if (depth > MAX_GRAPH_DEPTH || value == null) {
    return null;
  }

  if (typeof value === "string") {
    const url = value.trim();
    return isImportableUrl(url) ? { url, source: "jsonld" } : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const image = imageFrom(entry, depth + 1);

      if (image) {
        return image;
      }
    }

    return null;
  }

  const node = recordOf(value);
  const url = asText(node.url ?? node.contentUrl).trim();

  if (!url || !isImportableUrl(url)) {
    return null;
  }

  const width = Number(node.width);
  const height = Number(node.height);

  return {
    url,
    source: "jsonld",
    ...(Number.isInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isInteger(height) && height > 0 ? { height } : {})
  };
};

const videoUrlFrom = (value: unknown): string | null => {
  for (const entry of Array.isArray(value) ? value : [value]) {
    const node = recordOf(entry);

    for (const candidate of [node.contentUrl, node.embedUrl, node.url, entry]) {
      const url = asText(candidate).trim();

      if (url && isImportableUrl(url)) {
        return url;
      }
    }
  }

  return null;
};

const SCHEMA_NUTRITION_FIELDS: ReadonlyArray<readonly [keyof RecipeNutrition, string]> = [
  ["calories", "calories"],
  ["protein", "proteinContent"],
  ["carbohydrates", "carbohydrateContent"],
  ["fat", "fatContent"],
  ["fiber", "fiberContent"],
  ["sugar", "sugarContent"],
  ["sodium", "sodiumContent"]
];

const nutritionFrom = (value: unknown): RecipeNutrition | null => {
  const node = recordOf(value);
  const nutrition = emptyNutrition();

  for (const [key, field] of SCHEMA_NUTRITION_FIELDS) {
    const text = clip(oneLine(node[field]), MAX_RECIPE_NUTRITION_VALUE_LENGTH);
    nutrition[key] = text.length > 0 ? text : null;
  }

  return hasAnyNutrition(nutrition) ? nutrition : null;
};

const yieldFrom = (value: unknown): string => {
  const entries = (Array.isArray(value) ? value : [value])
    .map(oneLine)
    .filter((text) => text.length > 0);
  // ["16", "1 loaf"] is how many sites give "16 servings, 1 loaf"; keep both, drop repeats.
  return [...new Set(entries)].slice(0, 2).join(", ");
};

/**
 * Maps a schema.org Recipe (JSON-LD object, array or @graph, as found on recipe sites and in
 * Mela/Crouton-style exports): name, recipeIngredient, recipeInstructions (text, HowToStep,
 * HowToSection), recipeYield, prep/cook/total ISO durations, image, description, author,
 * publisher, recipeCuisine, recipeCategory, keywords, video, nutrition and aggregateRating.
 * Text is entity-decoded and stripped of HTML.
 */
export const schemaOrgRecipeToRecipe = (
  jsonLd: unknown,
  options: SchemaOrgImportOptions & RecipeImportOptions = {}
): RecipeImportResult => {
  const node = findSchemaOrgRecipe(jsonLd);
  const warnings: string[] = [];

  if (!node) {
    return {
      recipe: null,
      meta: { sourceUrl: options.sourceUrl ?? "", sourceUrlSynthetic: false },
      warnings: ["No schema.org Recipe was found."]
    };
  }

  const title = clip(oneLine(node.name), MAX_RECIPE_TITLE_LENGTH);
  const ingredientSource = Array.isArray(node.recipeIngredient)
    ? node.recipeIngredient
    : Array.isArray(node.ingredients)
      ? node.ingredients
      : lines(node.recipeIngredient ?? node.ingredients);
  const ingredientLines = (ingredientSource as unknown[]).map(oneLine);
  const { sourceUrl, synthetic } = resolveSourceUrl(
    [options.sourceUrl, node.url, node["@id"], node.mainEntityOfPage],
    "schema-org",
    title,
    `${title}\n${ingredientLines.join("\n")}`,
    options
  );
  const authors = names(node.author);
  const keywords = (
    Array.isArray(node.keywords)
      ? (node.keywords as unknown[]).map(oneLine)
      : oneLine(node.keywords).split(KEYWORD_SEPARATOR_PATTERN)
  )
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  const draft: RecipeDraft = {
    title,
    sourceUrl,
    sourceType: "recipe-webpage",
    image: imageFrom(node.image),
    ingredients: toIngredients(ingredientLines, warnings),
    steps: toSteps(instructionLines(node.recipeInstructions, null), warnings),
    servings: optionalText(yieldFrom(node.recipeYield ?? node.yield), MAX_RECIPE_SERVINGS_LENGTH),
    prepTimeMinutes: toMinutes(node.prepTime),
    cookTimeMinutes: toMinutes(node.cookTime),
    totalTimeMinutes: toMinutes(node.totalTime),
    nutrition: nutritionFrom(node.nutrition),
    description: optionalText(cleanText(node.description), MAX_RECIPE_DESCRIPTION_LENGTH),
    author: optionalText(authors.join(", "), MAX_RECIPE_AUTHOR_LENGTH),
    siteName: optionalText(names(node.publisher)[0] ?? "", 200),
    cuisine: optionalText(firstText(node.recipeCuisine), 100),
    category: optionalText(firstText(node.recipeCategory), 100),
    keywords: keywords.length > 0 ? keywords : null,
    videoUrl: videoUrlFrom(node.video)
  };
  const recipe = finalizeRecipe(draft, "Imported from schema.org recipe data.", "jsonld", warnings);
  const rating = toRating(recordOf(node.aggregateRating).ratingValue);

  return {
    recipe,
    meta: {
      sourceUrl,
      sourceUrlSynthetic: synthetic,
      ...(rating == null ? {} : { rating })
    },
    warnings
  };
};
