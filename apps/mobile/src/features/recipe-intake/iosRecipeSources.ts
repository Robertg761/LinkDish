import { isSupportedIosRecipeUrl, IOS_RECIPE_SOURCE_MESSAGE } from "@linkdish/recipe-domain";

export {
  isSupportedIosRecipeUrl,
  IOS_RECIPE_SOURCE_MESSAGE,
  IOS_RECIPE_SOURCES
} from "@linkdish/recipe-domain";

export const getRecipeSourceRestriction = (url: string, platform: string): string | null =>
  platform === "ios" && !isSupportedIosRecipeUrl(url) ? IOS_RECIPE_SOURCE_MESSAGE : null;
