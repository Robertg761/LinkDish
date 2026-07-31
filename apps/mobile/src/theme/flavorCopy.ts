export const EXTRACTION_ERROR_LINES = [
  "This recipe boiled over.",
  "That link burnt to a crisp.",
  "The kitchen got smoky — let's try that again."
] as const;

export const EMPTY_LIBRARY_LINES = [
  "Nothing simmering yet.",
  "Your shelf is bare.",
  "The recipe book awaits its first entry."
] as const;

export const COOK_MODE_FINALE_TITLE = "Bon appétit!";
export const COOK_MODE_FINALE_DONE_LABEL = "Done";

export const getCookModeFinaleBody = (recipeTitle: string) => `You cooked ${recipeTitle}.`;
export const getIngredientCheckboxLabel = (ingredientText: string) => `Toggle ${ingredientText}`;

export const selectFlavorCopyLine = <TLine extends string>(
  lines: readonly [TLine, ...TLine[]],
  randomValue = Math.random()
) => lines[Math.floor(Math.max(0, Math.min(0.999999, randomValue)) * lines.length)] ?? lines[0];
