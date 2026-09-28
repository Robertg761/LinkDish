/**
 * Compatibility entry point. Cook mode now lives in features/cook-mode and the scaling helpers
 * in features/recipe-view/recipe-scaling; older imports keep working through these re-exports.
 */
export { CookMode } from "../cook-mode/CookMode";
export type { CookModeProps } from "../cook-mode/CookMode";
export {
  DEFAULT_RECIPE_SCALING_STATE,
  getScaledIngredientText
} from "../recipe-view/recipe-scaling";
export type { RecipeScalingState } from "../recipe-view/recipe-scaling";
