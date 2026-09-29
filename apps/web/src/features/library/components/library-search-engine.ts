/**
 * The recipe-domain search engine, in its own chunk: the Cookbook is the entry route, so the
 * index builder and its word tables load when idle or on first search instead of up front.
 */
export {
  createRecipeSearchIndex,
  highlightRanges,
  recipeSearchFields
} from "@linkdish/recipe-domain";
