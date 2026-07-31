import { parseIngredientQuantity } from "./ingredient-quantities.js";

type IngredientInput = string | { text: string };

type IngredientCandidate = {
  index: number;
  phrases: readonly string[];
  singleAliases: readonly string[];
};

const descriptorStopwords = new Set([
  "a",
  "an",
  "and",
  "baby",
  "bite",
  "boneless",
  "chopped",
  "cooked",
  "crumbled",
  "cut",
  "diced",
  "drained",
  "fine",
  "finely",
  "fresh",
  "frozen",
  "grated",
  "greek",
  "halved",
  "into",
  "jasmine",
  "large",
  "light",
  "low",
  "medium",
  "of",
  "optional",
  "packed",
  "pieces",
  "plain",
  "purpose",
  "red",
  "removed",
  "rinsed",
  "sea",
  "seeded",
  "skinless",
  "sliced",
  "small",
  "sodium",
  "size",
  "strings",
  "thinly",
  "toasted",
  "unsalted",
  "warm"
]);

const genericSingleAliasBlocklist = new Set([
  "base",
  "dressing",
  "juice",
  "mixture",
  "oil",
  "sauce",
  "seed",
  "sugar"
]);

const preparedContextWords = new Set([
  "base",
  "dressing",
  "filling",
  "juice",
  "mixture",
  "oil",
  "sauce",
  "seed",
  "sugar",
  "vinegar"
]);

const frontAliasAllowlist = new Set(["pita"]);

const meatAliases = new Set(["beef", "chicken", "pork", "shrimp", "turkey"]);

const singularize = (token: string): string => {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("oes") && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("ses") && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
};

const normalizeTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize);

const phraseFromTokens = (tokens: readonly string[]): string | null => {
  if (tokens.length === 0) {
    return null;
  }

  return tokens.join(" ");
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const ingredientText = (ingredient: IngredientInput): string =>
  typeof ingredient === "string" ? ingredient : ingredient.text;

const itemTokensForIngredient = (ingredient: IngredientInput): string[] => {
  const parsed = parseIngredientQuantity(ingredientText(ingredient));
  const item = parsed.item.split(",")[0] ?? parsed.item;

  return normalizeTokens(item).filter((token) => !descriptorStopwords.has(token));
};

const buildCandidate = (ingredient: IngredientInput, index: number): IngredientCandidate | null => {
  const tokens = itemTokensForIngredient(ingredient);

  if (tokens.length === 0) {
    return null;
  }

  const phrases: string[] = [];
  const fullPhrase = phraseFromTokens(tokens);

  if (fullPhrase && tokens.length > 1) {
    phrases.push(fullPhrase);
  }

  if (tokens.length > 2) {
    const tailPhrase = phraseFromTokens(tokens.slice(-2));

    if (tailPhrase) {
      phrases.push(tailPhrase);
    }
  }

  const head = tokens[tokens.length - 1];
  const singleAliases: string[] = [];

  if (tokens.length === 1 && head) {
    singleAliases.push(head);
  } else if (head && !genericSingleAliasBlocklist.has(head)) {
    singleAliases.push(head);
  }

  const meatAlias = tokens.find((token) => meatAliases.has(token));
  if (meatAlias) {
    singleAliases.push(meatAlias);
  }

  const frontAlias = tokens[0];
  if (frontAlias && frontAliasAllowlist.has(frontAlias)) {
    singleAliases.push(frontAlias);
  }

  return {
    index,
    phrases: unique(phrases),
    singleAliases: unique(singleAliases)
  };
};

/**
 * Finds ingredient indexes that are explicitly referenced by a recipe step.
 *
 * Matching is case- and plural-insensitive, ignores parsed quantities/units,
 * and intentionally avoids generic one-word matches when they could point at
 * the wrong ingredient.
 */
export const matchStepIngredients = (stepText: string, ingredients: readonly IngredientInput[]): number[] => {
  const stepTokens = normalizeTokens(stepText);
  const stepTokenSet = new Set(stepTokens);
  const normalizedStep = ` ${stepTokens.join(" ")} `;
  const candidates = ingredients
    .map((ingredient, index) => buildCandidate(ingredient, index))
    .filter((candidate): candidate is IngredientCandidate => candidate != null);
  const aliasCounts = new Map<string, number>();

  for (const candidate of candidates) {
    for (const alias of candidate.singleAliases) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
    }
  }

  const matches: number[] = [];
  const hasSingleAlias = (alias: string): boolean =>
    stepTokens.some((token, index) => token === alias && !preparedContextWords.has(stepTokens[index + 1] ?? ""));

  for (const candidate of candidates) {
    const phraseMatched = candidate.phrases.some((phrase) => normalizedStep.includes(` ${phrase} `));
    const singleMatched = candidate.singleAliases.some(
      (alias) => (aliasCounts.get(alias) ?? 0) === 1 && stepTokenSet.has(alias) && hasSingleAlias(alias)
    );

    if (phraseMatched || singleMatched) {
      matches.push(candidate.index);
    }
  }

  return matches;
};
