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

const formatMinutes = (label: string, value: number | null) =>
  value == null || value <= 0 ? null : `${label} ${value} min`;

const decodeMetaText = (value: string) => decodeHtmlEntities(value).replace(/\u00a0/gu, " ");

export const buildRecipeMetaLine = (
  recipe: Pick<Recipe, "cookTimeMinutes" | "prepTimeMinutes" | "servings" | "sourceType">,
  options: { includeSourceType?: boolean } = {}
) =>
  [
    options.includeSourceType === false ? null : sourceTypeLabels[recipe.sourceType],
    recipe.servings ? decodeMetaText(recipe.servings) : null,
    formatMinutes("Prep", recipe.prepTimeMinutes),
    formatMinutes("Cook", recipe.cookTimeMinutes)
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
