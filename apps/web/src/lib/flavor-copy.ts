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
export const COOK_MODE_DONE_LABEL = "Done";

export const getCookModeFinaleMessage = (recipeTitle: string) => `You cooked ${recipeTitle}.`;

export const pickFlavorLine = <T extends readonly [string, ...string[]]>(lines: T): T[number] => {
  const index = Math.floor(Math.random() * lines.length);
  return lines[index] ?? lines[0];
};
