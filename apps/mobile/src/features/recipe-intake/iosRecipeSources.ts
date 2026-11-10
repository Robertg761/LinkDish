/** Sources reviewed for the iPhone release. Evidence: docs/release/ios-2.2.2/allowed-recipe-sources.md. */
export const IOS_RECIPE_SOURCES = [
  { name: "Public Domain Recipes", host: "publicdomainrecipes.com" }
] as const;

export const IOS_RECIPE_SOURCE_MESSAGE =
  "On iPhone, link imports currently support recipe pages from publicdomainrecipes.com. Choose a recipe from this source, or import text or photos you own or have permission to use.";

/** Exact HTTPS hosts and static recipe paths only; no redirect/query endpoints or subdomains. */
export const isSupportedIosRecipeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      IOS_RECIPE_SOURCES.some(({ host }) => host === url.hostname) &&
      /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/u.test(url.pathname) &&
      !["/tags/", "/authors/", "/categories/", "/about/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
};

export const getRecipeSourceRestriction = (url: string, platform: string): string | null =>
  platform === "ios" && !isSupportedIosRecipeUrl(url) ? IOS_RECIPE_SOURCE_MESSAGE : null;
