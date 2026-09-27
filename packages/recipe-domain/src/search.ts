/**
 * Library search shared by web and mobile. Build the index once per library change, then query
 * it on every keystroke: text is folded (diacritics, case), tokenized and singularized up front,
 * so a query is a handful of map lookups plus a binary search for the last word's prefix.
 */
import { singularizeNoun } from "./inflection.js";
import { recipeSourceLabel } from "./urls.js";

import type { Recipe } from "./recipe-schema.js";

export const SEARCH_FIELD_NAMES = [
  "title",
  "tags",
  "ingredients",
  "source",
  "notes",
  "steps"
] as const;

export type SearchFieldName = (typeof SEARCH_FIELD_NAMES)[number];

/** Field weights: a title hit outranks a tag, ingredient, source/notes or step hit. */
export const SEARCH_FIELD_BOOSTS: Readonly<Record<SearchFieldName, number>> = {
  title: 5,
  tags: 4,
  ingredients: 3,
  source: 2,
  notes: 2,
  steps: 1
};

type FieldText = string | readonly string[] | null | undefined;

export type RecipeSearchFields = Partial<Record<SearchFieldName, FieldText>>;

export type RecipeSearchFilter<T> = (record: T) => boolean;

export type RecipeSearchOptions<T> = {
  /** Every filter must accept a record for it to be returned (also for an empty query). */
  filters?: RecipeSearchFilter<T> | ReadonlyArray<RecipeSearchFilter<T>> | undefined;
  /** Maximum number of results. */
  limit?: number | undefined;
};

export type RecipeSearchResult<T> = {
  record: T;
  score: number;
  /** Fields in which at least one query word matched, strongest first. */
  matches: SearchFieldName[];
};

export type RecipeSearchIndex<T> = {
  /**
   * Ranked results. Every query word must match (AND); the last word also matches as a prefix
   * while it is being typed ("chick" finds "chicken"); other words match whole, falling back to
   * a weaker prefix match. An empty query returns every (filtered) record in its original order.
   */
  search: (query: string, options?: RecipeSearchOptions<T>) => Array<RecipeSearchResult<T>>;
  readonly size: number;
};

export type HighlightRange = { start: number; end: number };

const DIACRITIC_PATTERN = /[̀-ͯ]/gu;
/** Plain ASCII needs no Unicode normalization, which is the slow part of folding. */
const NON_ASCII_PATTERN = /[\u0080-\uffff]/;
const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const ENDS_WITH_SPACE_PATTERN = /\s$/u;
const STOPWORDS = new Set(["a", "an", "and", "the", "of", "or", "with", "in", "for", "to", "on"]);
const EXACT_WEIGHT = 1;
const LAST_WORD_PREFIX_WEIGHT = 0.7;
const INNER_WORD_PREFIX_WEIGHT = 0.4;
const TITLE_PHRASE_BONUS = 2;

/** Lowercase with diacritics removed ("Crème Brûlée" → "creme brulee"). */
export const foldSearchText = (text: string): string =>
  NON_ASCII_PATTERN.test(text)
    ? text.normalize("NFD").replace(DIACRITIC_PATTERN, "").toLowerCase()
    : text.toLowerCase();

const normalizeToken = (token: string): string => {
  const singular = singularizeNoun(token);
  return singular.length > 0 ? singular : token;
};

/** Search tokens for a text: folded, split on anything but letters and digits, singularized. */
export const tokenizeSearchText = (text: string): string[] =>
  (foldSearchText(text).match(TOKEN_PATTERN) ?? []).map(normalizeToken);

const fieldTexts = (value: FieldText): string =>
  value == null ? "" : typeof value === "string" ? value : value.join(" \n ");

const FIELD_BITS: Readonly<Record<SearchFieldName, number>> = {
  title: 1,
  tags: 2,
  ingredients: 4,
  source: 8,
  notes: 16,
  steps: 32
};

/** Highest boost among the fields in a bit mask, precomputed for all 64 masks. */
const MASK_BEST_BOOST: readonly number[] = Array.from({ length: 64 }, (_unused, mask) =>
  SEARCH_FIELD_NAMES.reduce(
    (best, field) =>
      (mask & FIELD_BITS[field]) !== 0 ? Math.max(best, SEARCH_FIELD_BOOSTS[field]) : best,
    0
  )
);

const lowerBound = (sorted: readonly string[], value: string): number => {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((sorted[middle] ?? "") < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
};

type QueryToken = { token: string; isLast: boolean };

const parseQuery = (query: string): QueryToken[] => {
  const tokens = tokenizeSearchText(query);
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
  const kept = meaningful.length > 0 ? meaningful : tokens;
  // A trailing space means the last word is finished, so it no longer matches as a prefix.
  const typingLastWord = !ENDS_WITH_SPACE_PATTERN.test(query);

  return kept.map((token, index) => ({
    token,
    isLast: typingLastWord && index === kept.length - 1
  }));
};

const toFilterList = <T>(
  filters: RecipeSearchOptions<T>["filters"]
): ReadonlyArray<RecipeSearchFilter<T>> =>
  filters == null ? [] : typeof filters === "function" ? [filters] : filters;

type Postings = { documents: number[]; masks: number[] };

/**
 * Builds a search index over any records. `getFields` returns the searchable text per field
 * (title, tags, ingredients, source, notes, steps); see `recipeSearchFields` for a Recipe.
 *
 * Postings are sorted document lists per token and per-query scoring uses typed arrays sized to
 * the library, so a query costs a few array passes even when a one-letter prefix expands to
 * dozens of words.
 */
export const createRecipeSearchIndex = <T>(
  records: readonly T[],
  getFields: (record: T) => RecipeSearchFields
): RecipeSearchIndex<T> => {
  const postings = new Map<string, Postings>();
  const foldedTitles: string[] = [];
  const singularCache = new Map<string, string>();
  const tokenize = (text: string): string[] =>
    (foldSearchText(text).match(TOKEN_PATTERN) ?? []).map((raw) => {
      let token = singularCache.get(raw);

      if (token === undefined) {
        token = normalizeToken(raw);
        singularCache.set(raw, token);
      }

      return token;
    });

  records.forEach((record, documentIndex) => {
    const fields = getFields(record);
    foldedTitles.push(tokenize(fieldTexts(fields.title)).join(" "));

    for (const field of SEARCH_FIELD_NAMES) {
      const text = fieldTexts(fields[field]);

      if (text.length === 0) {
        continue;
      }

      for (const token of tokenize(text)) {
        let entry = postings.get(token);

        if (!entry) {
          entry = { documents: [], masks: [] };
          postings.set(token, entry);
        }

        const last = entry.documents.length - 1;

        // Documents are visited in order, so a token's list stays sorted and unique.
        if (entry.documents[last] === documentIndex) {
          entry.masks[last] = (entry.masks[last] ?? 0) | FIELD_BITS[field];
        } else {
          entry.documents.push(documentIndex);
          entry.masks.push(FIELD_BITS[field]);
        }
      }
    }
  });

  const vocabulary = [...postings.keys()].sort();
  const documentCount = records.length;

  /** Adds one token's postings into the per-document best score and field mask arrays. */
  const accumulate = (
    entry: Postings | undefined,
    weight: number,
    scores: Float64Array,
    masks: Uint8Array
  ): void => {
    if (!entry) {
      return;
    }

    for (let position = 0; position < entry.documents.length; position += 1) {
      const documentIndex = entry.documents[position] ?? 0;
      const mask = entry.masks[position] ?? 0;
      const score = (MASK_BEST_BOOST[mask] ?? 0) * weight;

      if (score > (scores[documentIndex] ?? 0)) {
        scores[documentIndex] = score;
      }

      masks[documentIndex] = (masks[documentIndex] ?? 0) | mask;
    }
  };

  /** Best score of one query word per document (0 = no match), with the fields it matched. */
  const scoreToken = ({
    token,
    isLast
  }: QueryToken): { scores: Float64Array; masks: Uint8Array } => {
    const scores = new Float64Array(documentCount);
    const masks = new Uint8Array(documentCount);

    accumulate(postings.get(token), EXACT_WEIGHT, scores, masks);

    // The word being typed matches as a prefix; finished words only fall back to a prefix
    // match (weaker) so "chick rice" still finds "chicken rice".
    if (isLast || token.length >= 3) {
      const prefixWeight = isLast ? LAST_WORD_PREFIX_WEIGHT : INNER_WORD_PREFIX_WEIGHT;

      for (let index = lowerBound(vocabulary, token); index < vocabulary.length; index += 1) {
        const candidate = vocabulary[index] ?? "";

        if (!candidate.startsWith(token)) {
          break;
        }

        if (candidate !== token) {
          accumulate(postings.get(candidate), prefixWeight, scores, masks);
        }
      }
    }

    return { scores, masks };
  };

  const search = (
    query: string,
    options: RecipeSearchOptions<T> = {}
  ): Array<RecipeSearchResult<T>> => {
    const filters = toFilterList(options.filters);
    const accepts = (record: T) => filters.every((filter) => filter(record));
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const queryTokens = parseQuery(query);

    if (queryTokens.length === 0) {
      const all: Array<RecipeSearchResult<T>> = [];

      for (const record of records) {
        if (all.length >= limit) {
          break;
        }

        if (accepts(record)) {
          all.push({ record, score: 0, matches: [] });
        }
      }

      return all;
    }

    const totals = new Float64Array(documentCount);
    const totalMasks = new Uint8Array(documentCount);
    const alive = new Uint8Array(documentCount).fill(1);

    // AND across words: a document drops out as soon as one word misses it.
    for (const queryToken of queryTokens) {
      const { scores, masks } = scoreToken(queryToken);

      for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
        const score = scores[documentIndex] ?? 0;

        if (score === 0) {
          alive[documentIndex] = 0;
        } else {
          totals[documentIndex] = (totals[documentIndex] ?? 0) + score;
          totalMasks[documentIndex] =
            (totalMasks[documentIndex] ?? 0) | (masks[documentIndex] ?? 0);
        }
      }
    }

    const phrase = queryTokens.map((entry) => entry.token).join(" ");
    const results: Array<RecipeSearchResult<T> & { index: number }> = [];

    for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
      const record = records[documentIndex];

      if (alive[documentIndex] !== 1 || record === undefined || !accepts(record)) {
        continue;
      }

      let score = totals[documentIndex] ?? 0;

      if (queryTokens.length > 1 && (foldedTitles[documentIndex] ?? "").includes(phrase)) {
        score += TITLE_PHRASE_BONUS;
      }

      const mask = totalMasks[documentIndex] ?? 0;
      results.push({
        record,
        score: Math.round(score * 1000) / 1000,
        matches: SEARCH_FIELD_NAMES.filter((field) => (mask & FIELD_BITS[field]) !== 0),
        index: documentIndex
      });
    }

    results.sort((left, right) => right.score - left.score || left.index - right.index);

    return results
      .slice(0, limit)
      .map(({ record, score, matches }) => ({ record, score, matches }));
  };

  return { search, size: documentCount };
};

/**
 * Searchable fields for a Recipe: title; tags from keywords, cuisine, category and `extras.tags`;
 * ingredient and step text; the source label ("seriouseats.com"); and optional notes.
 */
export const recipeSearchFields = (
  recipe: Pick<Recipe, "title" | "ingredients" | "steps" | "sourceUrl"> &
    Partial<Pick<Recipe, "keywords" | "cuisine" | "category" | "author" | "siteName">>,
  extras: { notes?: string | null | undefined; tags?: readonly string[] | null | undefined } = {}
): RecipeSearchFields => ({
  title: recipe.title,
  tags: [
    ...(recipe.keywords ?? []),
    ...(extras.tags ?? []),
    ...(recipe.cuisine ? [recipe.cuisine] : []),
    ...(recipe.category ? [recipe.category] : [])
  ],
  ingredients: recipe.ingredients.map((ingredient) => ingredient.text),
  source: [recipeSourceLabel(recipe.sourceUrl), recipe.siteName ?? "", recipe.author ?? ""],
  notes: extras.notes ?? null,
  steps: recipe.steps.map((step) => step.text)
});

const WORD_WITH_OFFSETS_PATTERN = /[\p{L}\p{N}]+/gu;

/**
 * Character ranges in `text` to highlight for `query`, sorted and merged: whole words that match
 * a query word (singular or plural), or the typed prefix of a word for prefix matches
 * ("chick" in "Chicken"). Diacritics and case are ignored.
 */
export const highlightRanges = (text: string, query: string): HighlightRange[] => {
  const queryTokens = parseQuery(query);

  if (queryTokens.length === 0 || text.length === 0) {
    return [];
  }

  const ranges: HighlightRange[] = [];

  for (const match of text.matchAll(WORD_WITH_OFFSETS_PATTERN)) {
    const word = match[0];
    const start = match.index ?? 0;
    const folded = foldSearchText(word);
    const normalized = normalizeToken(folded);

    for (const { token } of queryTokens) {
      if (normalized === token || folded === token) {
        ranges.push({ start, end: start + word.length });
        break;
      }

      if (folded.startsWith(token) || normalized.startsWith(token)) {
        ranges.push({ start, end: start + Math.min(word.length, token.length) });
        break;
      }
    }
  }

  const merged: HighlightRange[] = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
};
