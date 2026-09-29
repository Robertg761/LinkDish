/*
 * Cheap regular-expression hints over raw HTML. They run before (or instead
 * of) a DOM parse, so this module must stay free of HTML parser imports.
 */
export const hasRecipeJsonLd = (html: string): boolean =>
  /"@type"\s*:\s*(?:"Recipe"|\[[^\]]*"Recipe")/i.test(html);

export const hasRecipeMicrodata = (html: string): boolean =>
  /itemtype\s*=\s*["'][^"']*Recipe/i.test(html);

export const hasUsableRecipeStructuredData = (html: string): boolean =>
  (hasRecipeJsonLd(html) &&
    /"recipeIngredient"\s*:\s*\[\s*(?:"|\{)/i.test(html) &&
    /"recipeInstructions"\s*:\s*(?:\[\s*(?:"|\{)|"(?:[^"\\]|\\.)+")/i.test(html)) ||
  (hasRecipeMicrodata(html) &&
    /itemprop\s*=\s*["'][^"']*recipeIngredient/i.test(html) &&
    /itemprop\s*=\s*["'][^"']*recipeInstructions/i.test(html));
