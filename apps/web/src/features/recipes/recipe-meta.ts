import type { Recipe } from "@linkdish/recipe-domain";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  "recipe-webpage": "Webpage",
  webpage: "Webpage",
  image: "Scanned image"
};

export const formatRecipeSourceType = (sourceType: string): string => {
  const normalized = sourceType.trim().toLowerCase();
  const knownLabel = SOURCE_TYPE_LABELS[normalized];

  if (knownLabel) {
    return knownLabel;
  }

  return normalized
    .replace(/^recipe-/u, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

export const formatRecipeServings = (
  servings: string | null | undefined,
  fallback: string | null = "Servings unknown"
): string | null => {
  const trimmed = servings?.trim();

  if (!trimmed) {
    return fallback;
  }

  return /^\d+(?:\.\d+)?$/u.test(trimmed) ? `${trimmed} servings` : trimmed;
};

const formatRecipeMinutes = (label: string, value: number | null | undefined): string | null =>
  value == null || value <= 0 ? null : `${label} ${value} min`;

type RecipeMetaLineOptions = {
  includeSourceType?: boolean;
  servingsFallback?: string | null;
};

export const buildRecipeMetaLine = (
  recipe: Pick<Recipe, "sourceType" | "servings" | "prepTimeMinutes" | "cookTimeMinutes">,
  { includeSourceType = true, servingsFallback = "Servings unknown" }: RecipeMetaLineOptions = {}
): string =>
  [
    includeSourceType ? formatRecipeSourceType(recipe.sourceType) : null,
    formatRecipeServings(recipe.servings, servingsFallback),
    formatRecipeMinutes("Prep", recipe.prepTimeMinutes),
    formatRecipeMinutes("Cook", recipe.cookTimeMinutes)
  ]
    .filter(Boolean)
    .join(" · ");
