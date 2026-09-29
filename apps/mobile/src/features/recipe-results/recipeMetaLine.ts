import { formatServings, getRecipeTimes } from "@linkdish/recipe-domain";
import { decodeHtmlEntities } from "@linkdish/utils";

import type { Recipe } from "@linkdish/recipe-domain";

const sourceTypeLabels: Record<Recipe["sourceType"], string> = {
  article: "Webpage",
  image: "Scanned image",
  "recipe-webpage": "Webpage",
  social: "Social post",
  unknown: "Unknown source",
  video: "Video",
  youtube: "YouTube"
};

const NBSP_PATTERN = /\u00a0/gu;

const decodeMetaText = (value: string) => decodeHtmlEntities(value).replace(NBSP_PATTERN, " ");

type RecipeMetaFields = Pick<
  Recipe,
  "cookTimeMinutes" | "prepTimeMinutes" | "servings" | "sourceType"
> & {
  totalTimeMinutes?: number | null | undefined;
};

/**
 * Clean servings label: "Serves 4", "Serves 16 · 1 loaf" or "24 cookies" instead of the raw
 * source text ("16, 1 loaf"). Text without a readable count is shown as written.
 */
export const formatRecipeServings = (servings: string | null | undefined): string | null => {
  if (!servings?.trim()) {
    return null;
  }

  const label = formatServings(decodeMetaText(servings));
  return label.length > 0 ? label : null;
};

/**
 * Prep, cook and total time labels ("Prep 15 min · Cook 3 hr · Total 3 hr 15 min"). The total
 * is only added when it says something new: when both parts are known, or when the recipe
 * gives its own total (resting or rising time).
 */
const formatRecipeTimes = (recipe: RecipeMetaFields): string[] => {
  const times = getRecipeTimes(recipe);
  const parts = [
    times.labels.prep ? `Prep ${times.labels.prep}` : null,
    times.labels.cook ? `Cook ${times.labels.cook}` : null
  ].filter((part): part is string => part != null);
  const hasDistinctOwnTotal =
    recipe.totalTimeMinutes != null && times.total !== times.prep && times.total !== times.cook;
  const showTotal =
    times.labels.total != null &&
    ((times.labels.prep != null && times.labels.cook != null) || hasDistinctOwnTotal);

  return showTotal ? [...parts, `Total ${times.labels.total}`] : parts;
};

export const buildRecipeMetaLine = (
  recipe: RecipeMetaFields,
  options: { compact?: boolean; includeSourceType?: boolean } = {}
) => {
  const servings = formatRecipeServings(recipe.servings);

  if (options.compact) {
    // Cookbook rows: servings and the one time that matters when choosing ("Serves 4 · 45 min").
    const total = getRecipeTimes(recipe).labels.total;
    return [servings, total].filter((part): part is string => Boolean(part)).join(" · ");
  }

  return [
    options.includeSourceType === false ? null : sourceTypeLabels[recipe.sourceType],
    servings,
    ...formatRecipeTimes(recipe)
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
};
