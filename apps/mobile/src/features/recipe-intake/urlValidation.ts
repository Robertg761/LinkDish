export const INVALID_RECIPE_URL_MESSAGE = "Enter a complete URL, including http:// or https://.";

export const isAllowedRecipeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
