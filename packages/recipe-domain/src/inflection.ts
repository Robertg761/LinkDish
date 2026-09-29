/**
 * English noun inflection for ingredient names. Scaling "1 large egg" to 2 has to say "eggs",
 * shopping aggregation has to see "eggs" and "egg" as one item, and search has to match
 * "tomatoes" with "tomato". The rules are deliberately small and food-focused: irregular forms
 * are listed explicitly, and nouns without a plural ("rice", "shrimp", "asparagus") never change.
 */

/**
 * Maps rather than object literals: a lookup of any word must not reach Object.prototype, where
 * "constructor" would come back as the Object function.
 */
const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ["leaf", "leaves"],
  ["loaf", "loaves"],
  ["half", "halves"],
  ["knife", "knives"],
  ["calf", "calves"],
  ["shelf", "shelves"],
  ["tomato", "tomatoes"],
  ["potato", "potatoes"],
  ["mango", "mangoes"],
  ["chili", "chilies"],
  ["chilli", "chillies"],
  ["hero", "heroes"],
  ["echo", "echoes"],
  ["tooth", "teeth"],
  ["foot", "feet"],
  ["goose", "geese"],
  ["mouse", "mice"],
  ["person", "people"],
  ["child", "children"],
  ["cactus", "cacti"],
  ["fungus", "fungi"],
  ["radius", "radii"]
]);

const IRREGULAR_SINGULARS: ReadonlyMap<string, string> = new Map(
  [...IRREGULAR_PLURALS].map(([singular, plural]) => [plural, singular])
);

/** Nouns that read the same in both numbers, or that are never counted. */
const INVARIANT_NOUNS = new Set([
  "asparagus",
  "barley",
  "bass",
  "bread",
  "broccoli",
  "bulgur",
  "butter",
  "cheese",
  "chives",
  "cod",
  "corn",
  "couscous",
  "deer",
  "fish",
  "flour",
  "grits",
  "haddock",
  "halibut",
  "hummus",
  "kale",
  "lettuce",
  "meat",
  "milk",
  "molasses",
  "news",
  "oats",
  "oil",
  "pasta",
  "quinoa",
  "rice",
  "salmon",
  "salt",
  "series",
  "sheep",
  "shrimp",
  "species",
  "spinach",
  "sugar",
  "swiss",
  "trout",
  "tuna",
  "water",
  "yeast",
  "yogurt"
]);

/** Singular nouns ending in "-ie" whose plural is "-ies" (so "cookies" is not "cooky"). */
const IE_SINGULARS = new Set([
  "birdie",
  "brownie",
  "calorie",
  "cookie",
  "genie",
  "hoagie",
  "movie",
  "pie",
  "pixie",
  "rookie",
  "smoothie",
  "tie",
  "veggie",
  "zombie"
]);

/** Singular nouns ending in "-che" (so "quiches" is not "quich"). */
const CHE_SINGULARS = new Set([
  "avalanche",
  "brioche",
  "cache",
  "cliche",
  "creche",
  "ganache",
  "niche",
  "quiche",
  "panache"
]);

/** Endings that look plural but are singular ("hummus", "glass", "basis"). */
const SINGULAR_S_ENDING_PATTERN = /(?:ss|us|is|ous|ys)$/u;
const ES_PLURAL_ENDING_PATTERN = /(?:ches|shes|sses|xes|zzes)$/u;
const SIBILANT_ENDING_PATTERN = /(?:s|x|z|ch|sh)$/u;
const CONSONANT_Y_ENDING_PATTERN = /[^aeiou]y$/u;
const LETTERS_ONLY_PATTERN = /^[a-zà-ÿ][a-zà-ÿ'-]*$/iu;

const matchCase = (original: string, replacement: string): string => {
  if (original.length > 1 && original === original.toUpperCase()) {
    return replacement.toUpperCase();
  }

  const first = original.charAt(0);
  return first !== first.toLowerCase()
    ? `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}`
    : replacement;
};

/** True for nouns that do not inflect ("rice", "shrimp", "asparagus"). */
export const isInvariantNoun = (word: string): boolean => INVARIANT_NOUNS.has(word.toLowerCase());

/** True when a word looks like an English plural ("eggs", "leaves", "berries"). */
export const isPluralNoun = (word: string): boolean => {
  const lower = word.toLowerCase();

  if (!LETTERS_ONLY_PATTERN.test(lower) || INVARIANT_NOUNS.has(lower)) {
    return false;
  }

  if (IRREGULAR_SINGULARS.has(lower)) {
    return true;
  }

  if (IRREGULAR_PLURALS.has(lower)) {
    return false;
  }

  return lower.length > 2 && lower.endsWith("s") && !SINGULAR_S_ENDING_PATTERN.test(lower);
};

/**
 * Singular form of a noun ("eggs" → "egg", "berries" → "berry", "leaves" → "leaf"). Words that
 * are not plural come back unchanged, with their original casing.
 */
export const singularizeNoun = (word: string): string => {
  const lower = word.toLowerCase();

  if (!isPluralNoun(lower)) {
    return word;
  }

  const irregular = IRREGULAR_SINGULARS.get(lower);
  if (irregular != null) {
    return matchCase(word, irregular);
  }

  if (lower.endsWith("ies") && lower.length > 4) {
    const ieSingular = lower.slice(0, -1);
    return matchCase(word, IE_SINGULARS.has(ieSingular) ? ieSingular : `${lower.slice(0, -3)}y`);
  }

  if (lower.endsWith("ches") && CHE_SINGULARS.has(lower.slice(0, -1))) {
    return matchCase(word, lower.slice(0, -1));
  }

  if (ES_PLURAL_ENDING_PATTERN.test(lower)) {
    return matchCase(word, lower.slice(0, -2));
  }

  return matchCase(word, lower.slice(0, -1));
};

/** Plural form of a noun ("egg" → "eggs", "berry" → "berries", "leaf" → "leaves"). */
export const pluralizeNoun = (word: string): string => {
  const lower = word.toLowerCase();

  if (!LETTERS_ONLY_PATTERN.test(lower) || INVARIANT_NOUNS.has(lower) || isPluralNoun(lower)) {
    return word;
  }

  const irregular = IRREGULAR_PLURALS.get(lower);
  if (irregular != null) {
    return matchCase(word, irregular);
  }

  if (CONSONANT_Y_ENDING_PATTERN.test(lower)) {
    return matchCase(word, `${lower.slice(0, -1)}ies`);
  }

  if (SIBILANT_ENDING_PATTERN.test(lower)) {
    return matchCase(word, `${lower}es`);
  }

  return matchCase(word, `${lower}s`);
};

/** Inflects a noun to agree with a count: 1 (or less) is singular, anything else plural. */
export const inflectNoun = (word: string, count: number): string =>
  count > 1 ? pluralizeNoun(word) : singularizeNoun(word);

/**
 * Where the noun phrase of an ingredient line ends: the first comma, parenthesis, bracket or
 * connective ("2 large eggs, beaten", "4 chicken breasts (about 2 lb)", "1 lime or lemon").
 */
const HEAD_PHRASE_END_PATTERN =
  /[,;([*]|\s[-–—]\s|\s(?:or|for|to|about|such|plus|and|with|at|in|from|if|as|divided|optional)\s/iu;
/**
 * One character of the head noun. The noun is found with backward scans (see runStart): the
 * end-anchored `([A-Za-zÀ-ÿ'-]+)(\s*)$` it replaces was retried at every position of a long run
 * of letters, which took seconds on a line of a few ten thousand characters.
 */
const WORD_CHARACTER = /[A-Za-zÀ-ÿ'-]/u;
const SPACE_CHARACTER = /\s/u;

/** Where the run of characters matching `character` that ends at `end` starts. */
const runStart = (text: string, end: number, character: RegExp): number => {
  let start = end;

  while (start > 0 && character.test(text[start - 1] ?? "")) {
    start -= 1;
  }

  return start;
};

const isNoteOpener = (character: string | undefined): boolean =>
  character === "(" || character === "[";
const isNoteCloser = (character: string | undefined): boolean =>
  character === ")" || character === "]";

/** Where the run of characters matching `character` that starts at `start` ends. */
const runEnd = (text: string, start: number, character: RegExp): number => {
  let end = start;

  while (end < text.length && character.test(text[end] ?? "")) {
    end += 1;
  }

  return end;
};

/**
 * Where the size notes that open a phrase end, as in "1 (8 inch) pie crust": 0 without any, 16
 * for "(8 inch) [thin] crust". Each note is whitespace, "(" or "[", anything up to the first ")"
 * or "]", then whitespace (the language of `\s*[([][^)\]]*[)\]]\s*`, repeated). A single forward
 * scan, so it stays linear on any number of notes or on an opener that is never closed.
 */
const leadingNotesEnd = (phrase: string): number => {
  let end = 0;
  let position = 0;

  while (position < phrase.length) {
    const opener = runEnd(phrase, position, SPACE_CHARACTER);

    if (!isNoteOpener(phrase[opener])) {
      break;
    }

    let closer = opener + 1;

    while (closer < phrase.length && !isNoteCloser(phrase[closer])) {
      closer += 1;
    }

    if (closer >= phrase.length) {
      break;
    }

    position = runEnd(phrase, closer + 1, SPACE_CHARACTER);
    end = position;
  }

  return end;
};

/**
 * Re-inflects the head noun of an ingredient phrase for a new count, leaving everything after
 * the noun phrase untouched: ("large eggs, beaten", 1) → "large egg, beaten".
 *
 * `originalCount` guards mass nouns: the noun only changes when its current number agrees with
 * the amount it was written with, so "2 garlic, minced" or "3 celery" are left alone.
 */
export const inflectIngredientPhrase = (
  phrase: string,
  originalCount: number,
  nextCount: number
): string => {
  const notesEnd = leadingNotesEnd(phrase);
  const rest = phrase.slice(notesEnd);
  const endMatch = HEAD_PHRASE_END_PATTERN.exec(rest);
  const headEnd = endMatch ? endMatch.index : rest.length;
  const head = rest.slice(0, headEnd);
  const wordEnd = runStart(head, head.length, SPACE_CHARACTER);
  const wordStart = runStart(head, wordEnd, WORD_CHARACTER);
  const word = head.slice(wordStart, wordEnd);

  if (word.length < 2 || isInvariantNoun(word) || word.includes("-")) {
    return phrase;
  }

  const wasPlural = isPluralNoun(word);
  const originalWantsPlural = originalCount > 1;

  if (wasPlural !== originalWantsPlural) {
    return phrase;
  }

  const inflected = inflectNoun(word, nextCount);

  if (inflected === word) {
    return phrase;
  }

  return `${phrase.slice(0, notesEnd + wordStart)}${inflected}${phrase.slice(notesEnd + wordEnd)}`;
};
