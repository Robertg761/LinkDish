import { SAMPLE_RECIPES } from "@linkdish/recipe-domain";

import type { FeaturedRecipe } from "./types";

/**
 * The sample recipes LinkDish shows to everyone (the /featured/<slug> pages, the cookbook's "Try
 * a sample" shelf, the importer's samples and the first-run welcome).
 *
 * Only LinkDish's own recipes belong here: the original LinkDish kitchen starters from
 * @linkdish/recipe-domain. Sample pages are LinkDish publishing a recipe itself, not a cook saving
 * a copy for their own kitchen, so a recipe from another site (with its text and photo) must
 * never be added here without the publisher's written permission. Until 2026-11-08 this list
 * held eight King Arthur Baking and Food.com recipes with their photos and no recorded
 * permission; they were removed for that reason (see outputs/CONTENT-RIGHTS-REVIEW.md).
 */
export const featuredRecipes: readonly FeaturedRecipe[] = SAMPLE_RECIPES.map((sample) => ({
  slug: sample.id.replace(/^starter-/u, ""),
  sourceUrl: sample.recipe.sourceUrl,
  recipe: sample.recipe,
  extraction: {
    fetchMode: "http",
    provenance: ["llm"],
    strategy: "llm-fallback",
    warnings: []
  }
}));

/** Every featured recipe is LinkDish's own (see above); this keeps that checkable in tests. */
export const LINKDISH_OWNED_SOURCE_PATTERN = /^https:\/\/linkdish\.ca\/starter\//u;

export const getFeaturedRecipeBySlug = (slug: string | undefined): FeaturedRecipe | undefined =>
  featuredRecipes.find((recipe) => recipe.slug === slug);
