/*
 * A cheap check that free text (a TikTok caption, pasted notes) contains a recipe before an LLM
 * call is spent on it. It is deliberately lenient and language-tolerant: quantities with units
 * are the strongest signal ("200 g", "2 cups", "½ tsp"), recipe section words and cooking verbs
 * add support. A caption like "the best pasta ever 😍 #foodtok" does not pass.
 */
const quantityWithUnitPattern =
  /(?:\d+(?:[.,/]\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞])\s*(?:-\s*\d+\s*)?(?:cups?|tbsps?|tablespoons?|tbs|tsps?|teaspoons?|g|gr|grams?|kg|kilos?|mg|ml|cl|dl|l|liters?|litres?|oz|ounces?|lbs?|pounds?|cloves?|pinch(?:es)?|dash(?:es)?|cans?|tins?|sticks?|slices?|eggs?|el|tl|cs|cc|cucharadas?|cucharaditas?|cuillères?)\b/giu;
const sectionWordPattern =
  /\b(?:ingredients?|instructions?|directions?|method|steps?|recipe|zutaten|zubereitung|ingrédients|préparation|ingredientes|preparación|ingredienti|preparazione|ingrediënten|bereiding)\b/iu;
const cookingVerbPattern =
  /\b(?:bake|boil|simmer|stir|mix|whisk|fry|roast|chop|dice|mince|slice|preheat|combine|add|cook|serve|blend|knead|marinate|season|saut[eé]|grill|drain|fold|pour|heat|melt|toss)\b/giu;

const countMatches = (text: string, pattern: RegExp): number => {
  pattern.lastIndex = 0;
  let count = 0;

  while (pattern.exec(text) !== null) {
    count += 1;

    if (count >= 10) {
      break;
    }
  }

  pattern.lastIndex = 0;
  return count;
};

export interface RecipeTextSignals {
  quantities: number;
  hasSectionWord: boolean;
  cookingVerbs: number;
  looksLikeRecipe: boolean;
}

export const readRecipeTextSignals = (text: string): RecipeTextSignals => {
  const sample = text.slice(0, 20_000);
  const quantities = countMatches(sample, quantityWithUnitPattern);
  const hasSectionWord = sectionWordPattern.test(sample);
  const cookingVerbs = countMatches(sample, cookingVerbPattern);

  return {
    quantities,
    hasSectionWord,
    cookingVerbs,
    looksLikeRecipe:
      quantities >= 2 ||
      (hasSectionWord && (quantities >= 1 || cookingVerbs >= 2)) ||
      (quantities >= 1 && cookingVerbs >= 2)
  };
};

export const looksLikeRecipeText = (text: string): boolean =>
  readRecipeTextSignals(text).looksLikeRecipe;
