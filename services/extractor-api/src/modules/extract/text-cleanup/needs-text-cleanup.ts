import type { Recipe } from "../../../../../../packages/recipe-domain/src/index.js";

/*
 * The Gemini cleanup pass used to run on every successful import, adding a
 * second LLM call (and 1-4 s) even for clean JSON-LD. It now only runs when the
 * parsed text shows an artifact the model is there to fix. Each check is cheap
 * and deliberately conservative: a false negative leaves text as extracted,
 * which is what the deterministic path always returned.
 */
const htmlTagPattern = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;
/* Entities that survived the normaliser's single decode pass (e.g. `&amp;amp;` → `&amp;`). */
const leftoverEntityPattern = /&(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});/i;
const navigationLabelPattern =
  /\b(?:jump to (?:the )?recipe|print (?:the )?recipe|pin (?:this |the )?recipe|save (?:this |the )?recipe|rate (?:this|the) recipe|skip to (?:main )?content|read more|click here)\b/i;
const adFragmentPattern =
  /\b(?:advertisement|sponsored(?: content)?|adchoices|ad choices|affiliate link|this post may contain affiliate)\b/i;
const excessiveWhitespacePattern = /[ \t]{2,}|[\r\n\t\u00a0]/;
const brokenPunctuationPattern = /\s[,.;:!?](?:\s|$)|\(\s*[,.;]|\(\(|\)\)/;
/* Mojibake (UTF-8 read as Latin-1), replacement characters and zero-width characters. */
const encodingArtifactPattern = /\u00c3[\u0080-\u00bf]|\u00e2\u20ac|\ufffd|[\u200b-\u200d\ufeff]/;

const minimumRepeatedChars = 10;
const minimumShoutingLetters = 10;

/* "Preheat the oven. Preheat the oven." — a line pasted twice (linear-time check). */
const isImmediateRepeat = (value: string): boolean => {
  const text = value.trim().toLowerCase();

  for (let gap = 0; gap <= 3; gap += 1) {
    const repeatedLength = (text.length - gap) / 2;

    if (!Number.isInteger(repeatedLength) || repeatedLength < minimumRepeatedChars) {
      continue;
    }

    const first = text.slice(0, repeatedLength);
    const middle = text.slice(repeatedLength, repeatedLength + gap);

    if (first === text.slice(repeatedLength + gap) && middle.trim() === "") {
      return true;
    }
  }

  return false;
};

const isShouting = (value: string): boolean => {
  const letters = value.replace(/[^\p{L}]/gu, "");

  if (letters.length < minimumShoutingLetters) {
    return false;
  }

  const uppercaseLetters = letters.replace(/[^\p{Lu}]/gu, "").length;
  return uppercaseLetters / letters.length >= 0.9;
};

const hasTextArtifact = (value: string): boolean =>
  htmlTagPattern.test(value) ||
  leftoverEntityPattern.test(value) ||
  navigationLabelPattern.test(value) ||
  adFragmentPattern.test(value) ||
  excessiveWhitespacePattern.test(value) ||
  value !== value.trim() ||
  brokenPunctuationPattern.test(value) ||
  encodingArtifactPattern.test(value) ||
  isImmediateRepeat(value) ||
  isShouting(value);

const hasDuplicateLines = (values: string[]): boolean => {
  const seen = new Set<string>();

  for (const value of values) {
    const key = value
      .replace(/[ \t]+/g, " ")
      .trim()
      .toLowerCase();

    if (!key) {
      continue;
    }

    if (seen.has(key)) {
      return true;
    }

    seen.add(key);
  }

  return false;
};

export type RecipeTextArtifact =
  | "duplicate_ingredients"
  | "duplicate_steps"
  | "ingredient_text"
  | "nutrition_text"
  | "section_text"
  | "servings_text"
  | "step_text"
  | "title";

/** The first artifact found, or null when the recipe text already looks clean. */
export const findRecipeTextArtifact = (recipe: Recipe): RecipeTextArtifact | null => {
  if (hasTextArtifact(recipe.title)) {
    return "title";
  }

  if (recipe.ingredients.some((ingredient) => hasTextArtifact(ingredient.text))) {
    return "ingredient_text";
  }

  if (
    recipe.ingredients.some(
      (ingredient) => ingredient.section != null && hasTextArtifact(ingredient.section)
    )
  ) {
    return "section_text";
  }

  if (recipe.steps.some((step) => hasTextArtifact(step.text))) {
    return "step_text";
  }

  if (recipe.servings != null && hasTextArtifact(recipe.servings)) {
    return "servings_text";
  }

  if (
    recipe.nutrition &&
    Object.values(recipe.nutrition).some((value) => value != null && hasTextArtifact(value))
  ) {
    return "nutrition_text";
  }

  /* The same line in two sections (vanilla in Cake and in Frosting) is legitimate. */
  if (
    hasDuplicateLines(
      recipe.ingredients.map((ingredient) => `${ingredient.section ?? ""}\n${ingredient.text}`)
    )
  ) {
    return "duplicate_ingredients";
  }

  if (hasDuplicateLines(recipe.steps.map((step) => step.text))) {
    return "duplicate_steps";
  }

  return null;
};

export const recipeNeedsTextCleanup = (recipe: Recipe): boolean =>
  findRecipeTextArtifact(recipe) !== null;
